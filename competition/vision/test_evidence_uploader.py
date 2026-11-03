import io
import hashlib
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path

from evidence_uploader import (
    EvidenceUploader,
    EvidenceUploadHttpError,
    EvidenceUploadOutbox,
    EvidenceUploadWorker,
)


JPEG = b"\xff\xd8\xffpayload\xff\xd9"


class Response:
    status = 201

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, _limit):
        return b'{"accepted":true,"created":true,"bound":false}'

    def getcode(self):
        return self.status


class EvidenceUploaderTests(unittest.TestCase):
    def entry(self):
        return {
            "evidenceId": "fall-1791609077775-7",
            "deviceId": "dayu200-living",
            "fileName": "fall-1791609077775-7-dayu200-living.jpg",
            "sha256": hashlib.sha256(JPEG).hexdigest().upper(),
        }

    def test_upload_uses_headers_and_never_places_secret_in_url(self):
        calls = []

        def opener(request, timeout):
            calls.append((request, timeout))
            return Response()

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / self.entry()["fileName"]
            path.write_bytes(JPEG)
            result = EvidenceUploader(
                "https://trusted.example.com", "private-ingest-key", opener=opener
            ).upload(self.entry(), path)
        self.assertTrue(result["accepted"])
        request, timeout = calls[0]
        self.assertNotIn("private-ingest-key", request.full_url)
        self.assertEqual("private-ingest-key", request.get_header("X-ingest-key"))
        self.assertEqual("dayu200-living", request.get_header("X-device-id"))
        self.assertEqual("PUT", request.method)
        self.assertEqual(5.0, timeout)

    def test_rejects_remote_plain_http_and_invalid_local_inputs(self):
        with self.assertRaises(ValueError):
            EvidenceUploader("http://example.com", "key")
        with self.assertRaises(ValueError):
            EvidenceUploader("https://user:pass@example.com", "key")
        with self.assertRaises(ValueError):
            EvidenceUploader("https://example.com?token=x", "key")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / self.entry()["fileName"]
            path.write_bytes(b"not-jpeg")
            with self.assertRaises(ValueError):
                EvidenceUploader("http://127.0.0.1:8080", "key").upload(self.entry(), path)

    def test_worker_retries_without_blocking_submit(self):
        attempts = []

        class Flaky:
            def upload(self, entry, path):
                attempts.append((entry, path))
                if len(attempts) < 3:
                    raise urllib.error.URLError("offline")
                return {"accepted": True}

        worker = EvidenceUploadWorker(Flaky(), attempts=3, retry_seconds=0, sleeper=lambda _: None)
        self.assertTrue(worker.submit(self.entry(), Path("snapshot.jpg")))
        worker.items.join()
        worker.close()
        self.assertEqual(3, len(attempts))

    def test_uploader_rejects_jpeg_changed_after_it_was_indexed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / self.entry()["fileName"]
            path.write_bytes(b"\xff\xd8\xffchanged\xff\xd9")
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                EvidenceUploader(
                    "http://127.0.0.1:8080", "key", opener=lambda *_args, **_kwargs: Response()
                ).upload(self.entry(), path)

    def test_http_auth_failure_is_permanent(self):
        def unauthorized(request, timeout):
            self.assertEqual(5.0, timeout)
            raise urllib.error.HTTPError(request.full_url, 401, "unauthorized", {}, None)

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / self.entry()["fileName"]
            path.write_bytes(JPEG)
            with self.assertRaises(EvidenceUploadHttpError) as raised:
                EvidenceUploader(
                    "https://trusted.example.com", "key", opener=unauthorized
                ).upload(self.entry(), path)
            self.assertTrue(raised.exception.permanent)
            raised.exception.__cause__.close()

    def test_persistent_outbox_recovers_after_worker_restart(self):
        class Offline:
            def upload(self, _entry, _path):
                raise urllib.error.URLError("offline")

        uploaded = []

        class Online:
            def upload(self, entry, path):
                uploaded.append((entry["evidenceId"], path.name))
                return {"accepted": True}

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / self.entry()["fileName"]
            path.write_bytes(JPEG)
            first = EvidenceUploadWorker(
                Offline(), attempts=1, outbox_root=root, retry_backoff_seconds=3600
            )
            self.assertTrue(first.submit(self.entry(), path))
            first.items.join()
            first.close()
            persisted = json.loads((root / "upload-outbox.json").read_text(encoding="utf-8"))
            self.assertEqual(1, len(persisted["records"]))
            self.assertNotIn("key", json.dumps(persisted).lower())

            second = EvidenceUploadWorker(
                Online(), attempts=1, outbox_root=root, index_entries=[self.entry()]
            )
            second.items.join()
            second.close()
            self.assertEqual([(self.entry()["evidenceId"], path.name)], uploaded)
            persisted = json.loads((root / "upload-outbox.json").read_text(encoding="utf-8"))
            self.assertEqual("uploaded", persisted["records"][0]["status"])

            third = EvidenceUploadWorker(
                Online(), attempts=1, outbox_root=root, index_entries=[self.entry()]
            )
            third.items.join()
            third.close()
            self.assertEqual(1, len(uploaded), "uploaded receipt must suppress restart duplicates")

    def test_missing_retained_file_is_removed_from_outbox_without_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / self.entry()["fileName"]
            path.write_bytes(JPEG)
            outbox = EvidenceUploadOutbox(root)
            self.assertTrue(outbox.enqueue(self.entry(), path))
            path.unlink()

            worker = EvidenceUploadWorker(
                EvidenceUploader("http://127.0.0.1:8080", "key"),
                attempts=1,
                outbox_root=root,
            )
            worker.items.join()
            worker.close()
            persisted = json.loads((root / "upload-outbox.json").read_text(encoding="utf-8"))
            self.assertEqual("invalid", persisted["records"][0]["status"])

    def test_corrupt_outbox_fails_closed_and_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outbox_path = root / "upload-outbox.json"
            outbox_path.write_text("{broken", encoding="utf-8")
            outbox = EvidenceUploadOutbox(root)
            path = root / self.entry()["fileName"]
            path.write_bytes(JPEG)
            self.assertTrue(outbox.load_error)
            self.assertFalse(outbox.enqueue(self.entry(), path))
            self.assertEqual("{broken", outbox_path.read_text(encoding="utf-8"))

            outbox.reconcile([self.entry()])
            self.assertFalse(outbox.load_error)
            self.assertEqual("pending", outbox.snapshot()[0]["status"])
            self.assertTrue((root / "upload-outbox.corrupt.json").exists())

    def test_reconcile_recovers_crash_between_index_write_and_submit(self):
        uploaded = []

        class Online:
            def upload(self, entry, _path):
                uploaded.append(entry["evidenceId"])
                return {"accepted": True}

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / self.entry()["fileName"]
            path.write_bytes(JPEG)
            worker = EvidenceUploadWorker(
                Online(), attempts=1, outbox_root=root, index_entries=[self.entry()]
            )
            worker.items.join()
            worker.close()
            self.assertEqual([self.entry()["evidenceId"]], uploaded)

    def test_runtime_reconcile_preserves_pending_backoff(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / self.entry()["fileName"]
            path.write_bytes(JPEG)
            outbox = EvidenceUploadOutbox(root)
            self.assertTrue(outbox.enqueue(self.entry(), path))
            outbox.defer(self.entry()["evidenceId"], 12345.0)
            outbox.reconcile([self.entry()], reset_backoff=False)
            self.assertEqual(12345.0, outbox.snapshot()[0]["nextAttemptAt"])
            outbox.reconcile([self.entry()], reset_backoff=True)
            self.assertEqual(0.0, outbox.snapshot()[0]["nextAttemptAt"])

    def test_outbox_capacity_never_evicts_pending_tasks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outbox = EvidenceUploadOutbox(root, capacity=2)
            accepted = []
            for index in range(3):
                entry = self.entry()
                entry["evidenceId"] = f"fall-{1000 + index}-7"
                entry["fileName"] = f"fall-{1000 + index}-7-dayu200-living.jpg"
                path = root / entry["fileName"]
                path.write_bytes(JPEG)
                accepted.append(outbox.enqueue(entry, path))
            self.assertEqual([True, True, False], accepted)
            self.assertEqual(
                ["fall-1000-7", "fall-1001-7"],
                [item["evidenceId"] for item in outbox.snapshot()],
            )

    def test_outbox_capacity_reclaims_uploaded_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outbox = EvidenceUploadOutbox(root, capacity=2)
            entries = []
            for index in range(3):
                entry = self.entry()
                entry["evidenceId"] = f"fall-{2000 + index}-7"
                entry["fileName"] = f"fall-{2000 + index}-7-dayu200-living.jpg"
                (root / entry["fileName"]).write_bytes(JPEG)
                entries.append(entry)
            self.assertTrue(outbox.enqueue(entries[0], root / entries[0]["fileName"]))
            outbox.mark(entries[0]["evidenceId"], "uploaded")
            self.assertTrue(outbox.enqueue(entries[1], root / entries[1]["fileName"]))
            self.assertTrue(outbox.enqueue(entries[2], root / entries[2]["fileName"]))
            self.assertEqual(
                [entries[1]["evidenceId"], entries[2]["evidenceId"]],
                [item["evidenceId"] for item in outbox.snapshot()],
            )


if __name__ == "__main__":
    unittest.main()
