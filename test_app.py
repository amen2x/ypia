import io
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import app as frontend


class ApiProxyTests(unittest.TestCase):
    def setUp(self):
        self.client = frontend.app.test_client()

    def backend_response(self):
        response = io.BytesIO(b'{"status":"ok"}')
        response.status = 200
        response.headers = {"Content-Type": "application/json"}
        return response

    def test_get_preserves_path_and_query(self):
        with patch.object(frontend.backend_opener, "open", return_value=self.backend_response()) as opened:
            response = self.client.get("/api/parent/background?userId=synthetic-parent&range=week")
        request = opened.call_args.args[0]
        self.assertEqual(request.full_url, "http://localhost:3000/api/parent/background?userId=synthetic-parent&range=week")
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(response.json, {"status": "ok"})

    def test_multipart_document_is_forwarded_intact(self):
        with patch.object(frontend.backend_opener, "open", return_value=self.backend_response()) as opened:
            response = self.client.post("/api/documents", data={"document": (io.BytesIO(b"synthetic content"), "test.png")})
        request = opened.call_args.args[0]
        self.assertEqual(request.get_method(), "POST")
        self.assertIn("multipart/form-data; boundary=", request.get_header("Content-type"))
        self.assertIn(b'name="document"; filename="test.png"', request.data)
        self.assertIn(b"synthetic content", request.data)
        self.assertEqual(response.status_code, 200)

    def test_patch_json_is_forwarded_intact(self):
        payload = {"userId": "synthetic-caregiver", "status": "done"}
        with patch.object(frontend.backend_opener, "open", return_value=self.backend_response()) as opened:
            response = self.client.patch("/api/caregiver/actions/synthetic-action", json=payload)
        request = opened.call_args.args[0]
        self.assertEqual(request.get_method(), "PATCH")
        self.assertEqual(request.get_header("Content-type"), "application/json")
        import json
        self.assertEqual(json.loads(request.data), payload)
        self.assertEqual(response.status_code, 200)

    def test_calendar_redirect_reaches_browser_without_following_google(self):
        destination = "https://calendar.google.com/calendar/render?action=TEMPLATE&dates=20261005/20261006"
        self.assertIsNone(frontend.PreserveRedirects().redirect_request(None, None, 302, "Found", {}, destination))
        redirect = HTTPError("http://localhost:3000/api/calendar/template", 302, "Found", {"Location": destination}, io.BytesIO(b"Found"))
        with patch.object(frontend.backend_opener, "open", side_effect=redirect) as opened:
            response = self.client.get("/api/calendar/template?title=Synthetic&date=2026-10-05")
        opened.assert_called_once()
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], destination)


if __name__ == "__main__":
    unittest.main()
