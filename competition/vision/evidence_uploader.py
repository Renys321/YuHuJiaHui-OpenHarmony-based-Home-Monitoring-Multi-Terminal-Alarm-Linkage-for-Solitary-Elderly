"""Non-blocking upload of locally persisted FALL evidence to the trusted backend."""

from __future__ import annotations

import json
import hashlib
import os
import queue
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable, Optional


EVIDENCE_ID_RE = re.compile(r"^fall-[0-9]{1,16}-(?:na|[0-9]{1,12})$")
DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
FILE_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+\.jpg$")
SHA256_RE = re.compile(r"^[A-Fa-f0-9]{64}$")


class EvidenceUploadHttpError(RuntimeError):
    def __init__(self, status: int) -> None:
        super().__init__(f"evidence upload HTTP {status}")
        self.status = status

    @property
    def permanent(self) -> bool:
        return 300 <= self.status < 500 and self.status not in (408, 425, 429)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        # Never forward the ingest credential to a redirect target.
        raise urllib.error.HTTPError(request.full_url, code, "redirect refused", headers, fp)


class EvidenceUploader:
    """Upload one immutable JPEG. The secret is supplied in memory, never in the URL."""

    def __init__(
        self,
        base_url: str,
        ingest_key: str,
        timeout_seconds: float = 5.0,
        opener: Optional[Callable] = None,
    ) -> None:
        parsed = urllib.parse.urlsplit(base_url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValueError("evidence upload URL must be absolute HTTP(S)")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("evidence upload URL must not contain credentials, query or fragment")
        if parsed.scheme == "http" and parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
            raise ValueError("remote evidence upload requires HTTPS")
        if not ingest_key:
            raise ValueError("evidence ingest key is required")
        if timeout_seconds <= 0 or timeout_seconds > 30:
            raise ValueError("evidence upload timeout must be in (0, 30]")
        self.base_url = base_url.rstrip("/")
        self.ingest_key = ingest_key
        self.timeout_seconds = float(timeout_seconds)
        self.opener = opener or urllib.request.build_opener(NoRedirect()).open

    def upload(self, entry: dict, jpeg_path: Path) -> dict:
        evidence_id = str(entry.get("evidenceId", ""))
        device_id = str(entry.get("deviceId", ""))
        expected_name = str(entry.get("fileName", ""))
        if EVIDENCE_ID_RE.fullmatch(evidence_id) is None:
            raise ValueError("invalid evidenceId")
        if DEVICE_ID_RE.fullmatch(device_id) is None:
            raise ValueError("invalid evidence deviceId")
        path = Path(jpeg_path)
        if path.name != expected_name or FILE_NAME_RE.fullmatch(path.name) is None:
            raise ValueError("invalid evidence file name")
        payload = path.read_bytes()
        if len(payload) < 5 or len(payload) > 2 * 1024 * 1024:
            raise ValueError("invalid evidence JPEG size")
        if payload[:3] != b"\xff\xd8\xff" or payload[-2:] != b"\xff\xd9":
            raise ValueError("invalid evidence JPEG")
        expected_sha256 = str(entry.get("sha256", ""))
        if SHA256_RE.fullmatch(expected_sha256) is None:
            raise ValueError("invalid evidence SHA-256")
        if hashlib.sha256(payload).hexdigest().upper() != expected_sha256.upper():
            raise ValueError("evidence JPEG SHA-256 mismatch")
        url = f"{self.base_url}/internal/v1/evidence/{urllib.parse.quote(evidence_id, safe='')}"
        request = urllib.request.Request(
            url,
            data=payload,
            method="PUT",
            headers={
                "Content-Type": "image/jpeg",
                "X-Device-Id": device_id,
                "X-Evidence-Sha256": str(entry.get("sha256", "")),
                "X-Ingest-Key": self.ingest_key,
            },
        )
        try:
            with self.opener(request, timeout=self.timeout_seconds) as response:
                status = int(getattr(response, "status", response.getcode()))
                body = response.read(64 * 1024)
        except urllib.error.HTTPError as error:
            raise EvidenceUploadHttpError(int(error.code)) from error
        if status < 200 or status >= 300:
            raise EvidenceUploadHttpError(status)
        try:
            result = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RuntimeError("evidence upload returned invalid JSON") from error
        if not isinstance(result, dict) or result.get("accepted") is not True:
            raise RuntimeError("evidence upload was not accepted")
        return result


class EvidenceUploadOutbox:
    """Atomic, credential-free upload state reconciled with the evidence index."""

    VERSION = 1

    def __init__(self, root: Path, capacity: int = 200) -> None:
        if capacity < 1 or capacity > 1000:
            raise ValueError("outbox capacity must be in [1, 1000]")
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "upload-outbox.json"
        self.capacity = capacity
        self.lock = threading.RLock()
        self.load_error = False
        self.records = self._load()

    @staticmethod
    def _safe_entry(entry: dict) -> Optional[dict]:
        evidence_id = str(entry.get("evidenceId", ""))
        device_id = str(entry.get("deviceId", ""))
        file_name = str(entry.get("fileName", ""))
        sha256 = str(entry.get("sha256", "")).upper()
        if (EVIDENCE_ID_RE.fullmatch(evidence_id) is None
                or DEVICE_ID_RE.fullmatch(device_id) is None
                or FILE_NAME_RE.fullmatch(file_name) is None
                or SHA256_RE.fullmatch(sha256) is None):
            return None
        attempts = entry.get("attempts", 0)
        next_attempt_at = entry.get("nextAttemptAt", 0)
        status = str(entry.get("status", "pending"))
        if not isinstance(attempts, int) or attempts < 0:
            return None
        if not isinstance(next_attempt_at, (int, float)) or next_attempt_at < 0:
            return None
        if status not in ("pending", "uploaded", "invalid"):
            return None
        return {
            "evidenceId": evidence_id,
            "deviceId": device_id,
            "fileName": file_name,
            "sha256": sha256,
            "attempts": attempts,
            "nextAttemptAt": float(next_attempt_at),
            "status": status,
        }

    @staticmethod
    def _same_evidence(left: dict, right: dict) -> bool:
        return all(left.get(key) == right.get(key)
                   for key in ("evidenceId", "deviceId", "fileName", "sha256"))

    def reconcile(self, index_entries: list[dict], reset_backoff: bool = True) -> None:
        """Recover index-only records and retain bounded uploaded receipts."""
        with self.lock:
            safe_index = []
            for entry in index_entries[-self.capacity:]:
                safe = self._safe_entry(entry) if isinstance(entry, dict) else None
                if safe is not None:
                    safe_index.append(safe)
            existing = {item["evidenceId"]: item for item in self.records}
            reconciled = []
            for safe in safe_index:
                previous = existing.get(safe["evidenceId"])
                if previous is None:
                    safe["status"] = "pending"
                    safe["attempts"] = 0
                    safe["nextAttemptAt"] = 0.0
                    reconciled.append(safe)
                elif self._same_evidence(previous, safe):
                    if reset_backoff and previous["status"] == "pending":
                        # A process restart is a fresh connectivity opportunity.
                        previous["nextAttemptAt"] = 0.0
                    reconciled.append(previous)
                else:
                    safe["status"] = "invalid"
                    safe["attempts"] = 0
                    safe["nextAttemptAt"] = 0.0
                    reconciled.append(safe)
                    print(
                        f"[vision] evidence upload state conflict id={safe['evidenceId']}; upload disabled",
                        flush=True,
                    )
            if self.load_error and self.path.exists():
                try:
                    os.replace(self.path, self.root / "upload-outbox.corrupt.json")
                except OSError:
                    pass
            self.records = reconciled
            self.load_error = False
            self._write()

    def enqueue(self, entry: dict, jpeg_path: Path) -> bool:
        with self.lock:
            if self.load_error:
                return False
            safe = self._safe_entry(entry)
            path = Path(jpeg_path).resolve()
            if safe is None or path.parent != self.root or path.name != safe["fileName"]:
                return False
            previous = next(
                (item for item in self.records if item["evidenceId"] == safe["evidenceId"]), None)
            if previous is not None:
                if not self._same_evidence(previous, safe):
                    return False
                if previous["status"] == "uploaded":
                    return True
            safe["attempts"] = 0
            safe["nextAttemptAt"] = 0.0
            safe["status"] = "pending"
            self.records = [item for item in self.records if item["evidenceId"] != safe["evidenceId"]]
            self.records.append(safe)
            if len(self.records) > self.capacity:
                removable = next(
                    (item for item in self.records if item["status"] in ("uploaded", "invalid")),
                    None,
                )
                if removable is None:
                    self.records.pop()
                    return False
                self.records.remove(removable)
            self._write()
            return True

    def mark(self, evidence_id: str, status: str) -> None:
        if status not in ("uploaded", "invalid"):
            raise ValueError("invalid outbox status")
        with self.lock:
            for item in self.records:
                if item["evidenceId"] == evidence_id:
                    item["status"] = status
                    item["nextAttemptAt"] = 0.0
                    self._write()
                    return

    def defer(self, evidence_id: str, next_attempt_at: float) -> None:
        with self.lock:
            for item in self.records:
                if item["evidenceId"] == evidence_id:
                    if item["status"] != "pending":
                        return
                    item["attempts"] += 1
                    item["nextAttemptAt"] = max(0.0, float(next_attempt_at))
                    self._write()
                    return

    def due(self, now: float) -> list[dict]:
        with self.lock:
            return [dict(item) for item in self.records
                    if item["status"] == "pending" and item["nextAttemptAt"] <= now]

    def get(self, evidence_id: str) -> Optional[dict]:
        with self.lock:
            for item in self.records:
                if item["evidenceId"] == evidence_id:
                    return dict(item)
            return None

    def snapshot(self) -> list[dict]:
        with self.lock:
            return [dict(item) for item in self.records]

    def entry_and_path(self, record: dict) -> tuple[dict, Path]:
        return dict(record), self.root / record["fileName"]

    def _load(self) -> list[dict]:
        if not self.path.exists():
            return []
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(value, dict) or value.get("version") != self.VERSION:
                raise ValueError("unsupported outbox format")
            raw_records = value.get("records")
            if not isinstance(raw_records, list) or len(raw_records) > self.capacity:
                raise ValueError("invalid outbox records")
            records = []
            ids = set()
            for raw in raw_records:
                if not isinstance(raw, dict):
                    raise ValueError("invalid outbox record")
                safe = self._safe_entry(raw)
                if safe is None or safe["evidenceId"] in ids:
                    raise ValueError("invalid or duplicate outbox record")
                ids.add(safe["evidenceId"])
                records.append(safe)
            return records
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self.load_error = True
            print("[vision] evidence upload outbox is invalid; automatic upload disabled", flush=True)
            return []

    def _write(self) -> None:
        temporary = self.root / ".upload-outbox.json.tmp"
        with temporary.open("w", encoding="utf-8", newline="\n") as output:
            json.dump(
                {"version": self.VERSION, "records": self.records},
                output,
                ensure_ascii=False,
                indent=2,
            )
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, self.path)


class EvidenceUploadWorker:
    """Bounded background queue so backend outages never block FALL detection/MQTT."""

    def __init__(
        self,
        uploader: EvidenceUploader,
        attempts: int = 3,
        retry_seconds: float = 1.0,
        capacity: int = 32,
        sleeper: Callable[[float], None] = time.sleep,
        outbox_root: Optional[Path] = None,
        retry_backoff_seconds: float = 30.0,
        index_entries: Optional[list[dict]] = None,
    ) -> None:
        self.uploader = uploader
        if not isinstance(attempts, int) or attempts < 1 or attempts > 10:
            raise ValueError("attempts must be in [1, 10]")
        if capacity < 1 or capacity > 200 or retry_seconds < 0 or retry_backoff_seconds < 0:
            raise ValueError("invalid upload queue limits")
        self.attempts = attempts
        self.retry_seconds = retry_seconds
        self.sleeper = sleeper
        self.retry_backoff_seconds = retry_backoff_seconds
        self.outbox = EvidenceUploadOutbox(outbox_root, capacity) if outbox_root is not None else None
        if self.outbox is not None and index_entries is not None:
            self.outbox.reconcile(index_entries, reset_backoff=True)
        self.items: queue.Queue[Optional[tuple[dict, Path]]] = queue.Queue(maxsize=capacity)
        self.queued_ids: set[str] = set()
        self.lock = threading.Lock()
        self.closing = threading.Event()
        self.thread = threading.Thread(target=self._run, name="evidence-upload", daemon=True)
        self.thread.start()
        if self.outbox is not None and not self.outbox.load_error:
            for record in self.outbox.due(time.time()):
                entry, path = self.outbox.entry_and_path(record)
                self._queue(entry, path)

    def submit(self, entry: dict, jpeg_path: Path) -> bool:
        if self.closing.is_set():
            return False
        if self.outbox is not None:
            try:
                if not self.outbox.enqueue(entry, jpeg_path):
                    print("[vision] evidence upload outbox rejected task; local JPEG retained", flush=True)
                    return False
            except OSError:
                print("[vision] evidence upload outbox write failed; local JPEG retained", flush=True)
                return False
            persisted = self.outbox.get(str(entry.get("evidenceId", "")))
            if persisted is None or persisted["status"] != "pending":
                return persisted is not None
        return self._queue(dict(entry), Path(jpeg_path))

    def reconcile(self, index_entries: list[dict]) -> None:
        if self.outbox is None:
            return
        try:
            self.outbox.reconcile(index_entries, reset_backoff=False)
        except OSError as error:
            print(f"[vision] evidence upload reconcile failed: {error}", flush=True)
            return
        for record in self.outbox.due(time.time()):
            entry, path = self.outbox.entry_and_path(record)
            self._queue(entry, path)

    def _queue(self, entry: dict, jpeg_path: Path) -> bool:
        evidence_id = str(entry.get("evidenceId", ""))
        with self.lock:
            if evidence_id in self.queued_ids:
                return True
            self.queued_ids.add(evidence_id)
        try:
            self.items.put_nowait((dict(entry), Path(jpeg_path)))
            return True
        except queue.Full:
            with self.lock:
                self.queued_ids.discard(evidence_id)
            print("[vision] evidence upload queue full; local JPEG retained", flush=True)
            return False

    def close(self, timeout_seconds: float = 5.0) -> None:
        self.closing.set()
        try:
            self.items.put(None, timeout=timeout_seconds)
        except queue.Full:
            return
        self.thread.join(timeout_seconds)

    def _run(self) -> None:
        while True:
            try:
                item = self.items.get(timeout=1.0)
            except queue.Empty:
                if self.outbox is not None and not self.closing.is_set():
                    for record in self.outbox.due(time.time()):
                        entry, path = self.outbox.entry_and_path(record)
                        self._queue(entry, path)
                continue
            if item is None:
                self.items.task_done()
                return
            entry, jpeg_path = item
            try:
                self._process(entry, jpeg_path)
            except Exception as error:
                print(f"[vision] evidence worker contained unexpected error: {error}", flush=True)
            finally:
                with self.lock:
                    self.queued_ids.discard(str(entry.get("evidenceId", "")))
                self.items.task_done()

    def _process(self, entry: dict, jpeg_path: Path) -> None:
        evidence_id = str(entry.get("evidenceId", ""))
        last_error: Optional[Exception] = None
        permanent_failure = False
        for attempt in range(self.attempts):
            try:
                self.uploader.upload(entry, jpeg_path)
                print(f"[vision] evidence uploaded id={entry.get('evidenceId', '')}", flush=True)
                if self.outbox is not None:
                    try:
                        self.outbox.mark(evidence_id, "uploaded")
                    except OSError as state_error:
                        print(f"[vision] evidence receipt write failed: {state_error}", flush=True)
                last_error = None
                break
            except (FileNotFoundError, ValueError) as error:
                last_error = error
                permanent_failure = True
                if self.outbox is not None:
                    try:
                        self.outbox.mark(evidence_id, "invalid")
                    except OSError as state_error:
                        print(f"[vision] evidence invalid state write failed: {state_error}", flush=True)
                break
            except EvidenceUploadHttpError as error:
                last_error = error
                permanent_failure = error.permanent
                if permanent_failure:
                    if self.outbox is not None:
                        try:
                            self.outbox.mark(evidence_id, "invalid")
                        except OSError as state_error:
                            print(f"[vision] evidence invalid state write failed: {state_error}", flush=True)
                    break
                if attempt + 1 < self.attempts:
                    self.sleeper(self.retry_seconds * (attempt + 1))
            except (OSError, RuntimeError, urllib.error.URLError) as error:
                last_error = error
                if attempt + 1 < self.attempts:
                    self.sleeper(self.retry_seconds * (attempt + 1))
        if last_error is not None:
            print(
                f"[vision] evidence upload failed id={entry.get('evidenceId', '')}; "
                f"local JPEG retained permanent={permanent_failure}",
                flush=True,
            )
            if self.outbox is not None and not permanent_failure:
                next_attempt_at = time.time() + self.retry_backoff_seconds
                try:
                    self.outbox.defer(evidence_id, next_attempt_at)
                except OSError as state_error:
                    print(f"[vision] evidence retry state write failed: {state_error}", flush=True)
