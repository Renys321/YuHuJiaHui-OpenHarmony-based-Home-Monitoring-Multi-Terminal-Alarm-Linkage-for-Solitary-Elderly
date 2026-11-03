import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from yolo_pose_service import FallEvidenceStore


class FallEvidenceStoreTests(unittest.TestCase):
    @staticmethod
    def record(ts, track=7, score=0.91):
        return {"ts": ts, "trackId": track, "score": score}

    def test_saves_trigger_jpeg_and_atomic_index(self):
        with tempfile.TemporaryDirectory() as directory:
            store = FallEvidenceStore(Path(directory), max_events=3)
            payload = b"\xff\xd8trigger-frame\xff\xd9"

            entry = store.save(payload, self.record(1234), "dayu200-living")

            self.assertEqual("fall-1234-7", entry["evidenceId"])
            self.assertEqual(hashlib.sha256(payload).hexdigest().upper(), entry["sha256"])
            self.assertEqual(payload, (Path(directory) / entry["fileName"]).read_bytes())
            index = json.loads((Path(directory) / "index.json").read_text(encoding="utf-8"))
            self.assertEqual([entry], index)
            self.assertFalse((Path(directory) / ".index.json.tmp").exists())

    def test_retention_deletes_oldest_snapshot_and_index_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            store = FallEvidenceStore(Path(directory), max_events=2)
            first = store.save(b"one", self.record(1), "dayu200-living")
            second = store.save(b"two", self.record(2), "dayu200-living")
            third = store.save(b"three", self.record(3), "dayu200-living")

            self.assertFalse((Path(directory) / first["fileName"]).exists())
            self.assertTrue((Path(directory) / second["fileName"]).exists())
            self.assertTrue((Path(directory) / third["fileName"]).exists())
            index = json.loads((Path(directory) / "index.json").read_text(encoding="utf-8"))
            self.assertEqual(["fall-2-7", "fall-3-7"], [item["evidenceId"] for item in index])

    def test_duplicate_timestamp_gets_unique_event_id(self):
        with tempfile.TemporaryDirectory() as directory:
            store = FallEvidenceStore(Path(directory), max_events=2)
            first_record = self.record(9, track=None)
            first_record["evidenceId"] = store.event_id(first_record)
            first = store.save(b"old", first_record, "dayu200-living")
            second_record = self.record(9, track=None)
            second_record["evidenceId"] = store.event_id(second_record)
            second = store.save(b"new", second_record, "dayu200-living")

            self.assertEqual("fall-9-na", first["evidenceId"])
            self.assertEqual("fall-10-na", second["evidenceId"])
            self.assertEqual(2, len(store.records))
            self.assertEqual(b"old", (Path(directory) / first["fileName"]).read_bytes())
            self.assertEqual(b"new", (Path(directory) / second["fileName"]).read_bytes())

    def test_corrupt_index_is_quarantined_and_does_not_break_new_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "index.json").write_text('[1, {"broken":true}]', encoding="utf-8")
            store = FallEvidenceStore(root, max_events=2)
            self.assertFalse(store.index_trusted)
            self.assertEqual([], store.records)
            entry = store.save(b"new", self.record(11), "dayu200-living")
            self.assertEqual("fall-11-7", entry["evidenceId"])
            self.assertEqual(1, len(list(root.glob("index.corrupt-*.json"))))

    def test_rejects_invalid_source_and_empty_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            store = FallEvidenceStore(Path(directory), max_events=2)
            with self.assertRaises(ValueError):
                store.save(b"jpeg", self.record(1), "../../escape")
            with self.assertRaises(ValueError):
                store.save(b"", self.record(1), "dayu200-living")


if __name__ == "__main__":
    unittest.main()
