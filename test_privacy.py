# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 LucasHe1015
"""Privacy regression tests using only local temporary data and mocked engines.

Run: python -m unittest -v test_privacy
"""
import io
import json
from email.message import Message
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError
from zipfile import ZipFile

import export_source
import server


class RequestPrivacyTests(unittest.TestCase):
    def check_request(self, host="127.0.0.1:8765", origin=None, site=None):
        handler = object.__new__(server.Handler)
        handler.server = SimpleNamespace(server_address=("127.0.0.1", 8765))
        handler.headers = Message()
        handler.headers["Host"] = host
        if origin is not None:
            handler.headers["Origin"] = origin
        if site is not None:
            handler.headers["Sec-Fetch-Site"] = site
        handler._error = Mock()
        return handler._allow_local_request(), handler

    def test_normal_browser_and_local_clients(self):
        for host in ("127.0.0.1:8765", "localhost:8765"):
            with self.subTest(host=host):
                self.assertTrue(self.check_request(host)[0])
                self.assertTrue(self.check_request(host, "http://" + host, "same-origin")[0])
                self.assertTrue(self.check_request(host, site="none")[0])

    def test_cross_origin_and_rebinding_are_denied(self):
        cases = [
            ("untrusted.invalid:8765", None, None),
            ("127.0.0.1:8765", "https://untrusted.invalid", None),
            ("127.0.0.1:8765", "null", None),
            ("127.0.0.1:8765", None, "cross-site"),
            ("127.0.0.1:8765", None, "same-site"),
            ("127.0.0.1:8765", "http://localhost:8765", None),
            ("127.0.0.1:8765", "http://127.0.0.1:9999", None),
        ]
        for host, origin, site in cases:
            with self.subTest(host=host, origin=origin, site=site):
                allowed, handler = self.check_request(host, origin, site)
                self.assertFalse(allowed)
                self.assertTrue(handler.close_connection)
                self.assertEqual(handler._error.call_args.args[0], 403)

    def test_redirects_cannot_forward_credentials_to_other_origins(self):
        request = server.urlrequest.Request("https://example.invalid/models",
                                            headers={"Authorization": "Bearer synthetic-secret"})
        redirect = server._PrivateRedirectHandler()
        for destination in ("https://other.invalid/models", "http://example.invalid/models",
                            "https://example.invalid:444/models"):
            with self.subTest(destination=destination):
                with self.assertRaises(server.EngineError):
                    redirect.redirect_request(request, None, 302, "", {}, destination)
        same = redirect.redirect_request(request, None, 302, "", {},
                                         "https://example.invalid/v1/models")
        self.assertIsNotNone(same)

    def test_record_ids_cannot_escape_storage(self):
        with TemporaryDirectory() as folder:
            with self.assertRaises(server.BadRequest):
                server._write_record_file(Path(folder), {"id": "../outside"})

    def test_records_outside_user_data_are_not_read(self):
        with TemporaryDirectory() as folder:
            path = Path(folder) / "private.json"
            path.write_text('{"private": true}', encoding="utf-8")
            self.assertIsNone(server._read_record_file(path))

    def test_config_keys_are_redacted_without_mutation(self):
        cfg = json.loads(json.dumps(server.DEFAULT_CONFIG))
        for section in ("openai", "libretranslate"):
            cfg[section]["apiKey"] = "synthetic-secret"
        safe = server.redacted_config(cfg)
        self.assertNotIn("synthetic-secret", json.dumps(safe))
        for section in ("openai", "libretranslate"):
            self.assertTrue(safe[section]["hasApiKey"])
            self.assertEqual(cfg[section]["apiKey"], "synthetic-secret")

    def test_engine_errors_do_not_echo_url_or_body(self):
        url = "https://example.invalid/translate?key=synthetic-secret"
        errors = [
            HTTPError(url, 401, "synthetic-secret", {}, io.BytesIO(b"synthetic-private-text")),
            URLError("synthetic-secret"),
            TimeoutError("synthetic-private-text"),
        ]
        for error in errors:
            with self.subTest(error=type(error).__name__):
                with patch.object(server._http_opener, "open", side_effect=error):
                    with self.assertRaises(server.EngineError) as caught:
                        server.http_json(url)
                self.assertNotIn("synthetic-", caught.exception.message)
                self.assertNotIn("example.invalid", caught.exception.message)

    def test_changed_endpoint_does_not_reuse_stored_key(self):
        cfg = json.loads(json.dumps(server.DEFAULT_CONFIG))
        cfg["openai"].update(baseUrl="https://trusted.example/v1", apiKey="synthetic-secret")
        same = {
            "openai": {"baseUrl": "https://trusted.example/v1", "model": "", "apiKey": ""},
            "libretranslate": {"baseUrl": cfg["libretranslate"]["baseUrl"], "apiKey": ""},
        }
        changed = json.loads(json.dumps(same))
        changed["openai"]["baseUrl"] = "https://other.invalid/v1"
        self.assertEqual(
            server.merged_draft_config(cfg, same)["openai"]["apiKey"],
            "synthetic-secret",
        )
        self.assertEqual(
            server.merged_draft_config(cfg, changed)["openai"]["apiKey"],
            "",
        )
        with TemporaryDirectory() as folder:
            config_path = Path(folder) / "config.json"
            config_path.write_text(json.dumps(cfg), encoding="utf-8")
            with patch.object(server, "CONFIG_PATH", config_path):
                saved = server.save_config(changed)
            self.assertEqual(saved["openai"]["apiKey"], "")
            self.assertNotIn("synthetic-secret", config_path.read_text(encoding="utf-8"))


class ExportPrivacyTests(unittest.TestCase):
    def test_export_uses_allowlist_and_empty_glossary(self):
        with TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            for relative in export_source.SOURCE_FILES:
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("public source", encoding="utf-8")
            for relative in ("config.json", "user_data/history/private.json",
                             "screenshots/private.png", "data/glossary.json",
                             "models/private.gguf", ".git/config"):
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("synthetic-private-text", encoding="utf-8")
            with patch.object(export_source, "ROOT", root):
                target = export_source.export_source()
            with ZipFile(target) as archive:
                self.assertEqual(set(archive.namelist()),
                                 set(export_source.SOURCE_FILES) | {"data/glossary.json"})
                self.assertEqual(json.loads(archive.read("data/glossary.json"))["entries"], {})
                for name in archive.namelist():
                    self.assertNotIn(b"synthetic-private-text", archive.read(name))


if __name__ == "__main__":
    unittest.main()
