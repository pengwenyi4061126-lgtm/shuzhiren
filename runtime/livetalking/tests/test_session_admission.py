import asyncio
import argparse
import logging
import pathlib
import sys
import threading
import types
import unittest


LIVETALKING_SOURCE = None


def load_session_manager(source):
    sys.path.insert(0, str(source))
    logger_module = types.ModuleType("utils.logger")
    logger_module.logger = logging.getLogger("session-admission-test")
    utils_package = types.ModuleType("utils")
    utils_package.__path__ = []
    avatar_module = types.ModuleType("avatars.base_avatar")
    avatar_module.BaseAvatar = object
    avatars_package = types.ModuleType("avatars")
    avatars_package.__path__ = []
    sys.modules["utils"] = utils_package
    sys.modules["utils.logger"] = logger_module
    sys.modules["avatars"] = avatars_package
    sys.modules["avatars.base_avatar"] = avatar_module
    from server.session_manager import MaxSessionError, SessionManager
    return SessionManager, MaxSessionError


class SessionAdmissionTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        source = LIVETALKING_SOURCE or pathlib.Path(__file__).resolve().parents[3] / "vendor" / "LiveTalking"
        SessionManager, self.MaxSessionError = load_session_manager(source)
        self.manager = SessionManager()
        self.manager.sessions.clear()
        self.manager.set_max_session(1)

    async def asyncTearDown(self):
        self.manager.sessions.clear()

    async def test_concurrent_creates_reserve_the_single_slot(self):
        entered = threading.Event()
        release = threading.Event()
        builds = []

        def build(session_id, params):
            builds.append(session_id)
            entered.set()
            if not release.wait(timeout=3):
                raise TimeoutError("test build release timed out")
            return object()

        self.manager.init_builder(build)
        first = asyncio.create_task(self.manager.create_session({}, "first"))
        self.assertTrue(await asyncio.to_thread(entered.wait, 1))
        with self.assertRaises(self.MaxSessionError):
            await self.manager.create_session({}, "second")
        self.assertEqual(list(self.manager.sessions), ["first"])
        release.set()
        self.assertEqual(await first, "first")
        self.assertEqual(builds, ["first"])

    async def test_failed_build_releases_its_reservation(self):
        def fail(session_id, params):
            raise RuntimeError("synthetic build failure")

        self.manager.init_builder(fail)
        with self.assertRaisesRegex(RuntimeError, "synthetic build failure"):
            await self.manager.create_session({}, "failed")
        self.assertEqual(self.manager.sessions, {})
        self.manager.init_builder(lambda session_id, params: object())
        self.assertEqual(await self.manager.create_session({}, "retry"), "retry")

    async def test_cancelled_build_keeps_reservation_until_worker_stops(self):
        entered = threading.Event()
        release = threading.Event()

        def build(session_id, params):
            entered.set()
            if not release.wait(timeout=3):
                raise TimeoutError("test build release timed out")
            return object()

        self.manager.init_builder(build)
        pending = asyncio.create_task(self.manager.create_session({}, "cancelled"))
        self.assertTrue(await asyncio.to_thread(entered.wait, 1))
        pending.cancel()
        await asyncio.sleep(0)
        self.assertIn("cancelled", self.manager.sessions)
        with self.assertRaises(self.MaxSessionError):
            await self.manager.create_session({}, "second")
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.assertEqual(self.manager.sessions, {})

    async def test_duplicate_explicit_session_id_is_rejected(self):
        self.manager.init_builder(lambda session_id, params: object())
        await self.manager.create_session({}, "same")
        with self.assertRaises(self.MaxSessionError):
            await self.manager.create_session({}, "same")
        self.assertEqual(len(self.manager.sessions), 1)


def configure_test_arguments():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--livetalking-source", type=pathlib.Path)
    args, unittest_args = parser.parse_known_args()
    global LIVETALKING_SOURCE
    LIVETALKING_SOURCE = args.livetalking_source.resolve() if args.livetalking_source else None
    sys.argv[:] = [sys.argv[0], *unittest_args]


if __name__ == "__main__":
    configure_test_arguments()
    unittest.main()
