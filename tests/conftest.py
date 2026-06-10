# Redirect the app at a throwaway database BEFORE any test module imports
# nyx_step — otherwise tests write pid1/pid2/... into the production DB and
# fail on re-runs within the 7-day purge window.
import pathlib
import tempfile

import config
import core.db as db

_tmp_db = pathlib.Path(tempfile.mkdtemp(prefix="nyx_step_test_")) / "test.db"
config.DB_PATH = _tmp_db
db.init_db(_tmp_db)
