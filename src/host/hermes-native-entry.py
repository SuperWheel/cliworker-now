"""Use a verified current native venv with a separate account home, without installing.

The official launcher, checkout-derived install key and committed facts are checked by
Host. Recheck facts under the same install lock, then use Hermes' own generation lease.
No account/config content is copied, imported from another home, or printed here.
"""
import fcntl
import json
import os
from pathlib import Path
import stat
import sys

checkout, facts, environment = map(Path, sys.argv[1:4])
arguments = sys.argv[4:]
if any(path.resolve() != path for path in (checkout, facts, environment)):
    raise SystemExit("Hermes installation changed; reopen login settings")

def selected():
    fd = os.open(facts, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 4 * 1024 * 1024:
            raise RuntimeError("Invalid Hermes installation record")
        return json.load(stream).get("packages", {}).get("venv", {}).get("environment") == str(environment)

release = None
try:
    with open(facts.parent / ".install.lock", "a+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        if not selected():
            raise RuntimeError("Hermes installation changed; reopen login settings")
        sys.path.insert(0, str(checkout))
        from hermes_cli.runtime_state import lease_generation
        release = lease_generation(environment)
    os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
    os.environ.pop("PYTHONHOME", None)
    os.environ.pop("PYTHONPATH", None)
    os.environ.pop("VIRTUAL_ENV", None)
    sys.argv = [str(checkout / "hermes_cli/main.py"), *arguments]
    # The native API exposes these boundaries, but main/run_agent pass the
    # checkout's .env as a fallback. Pin its own home and disable that fallback
    # and secret-manager hydration before either module imports the function.
    # No parser or provider/login flow is replaced.
    account_home = Path(os.environ["HERMES_HOME"])
    if (account_home / ".cliworker-managed").exists() or (account_home / ".op.env").exists():
        raise RuntimeError("Hermes plugin login cannot use additional account configuration layers")
    from hermes_cli import env_loader
    native_dotenv = env_loader.load_hermes_dotenv
    def own_dotenv(**_options):
        if (account_home / ".cliworker-managed").exists():
            raise RuntimeError("Hermes plugin login cannot use an additional managed configuration")
        if (account_home / ".op.env").exists():
            raise RuntimeError("Hermes plugin login supports its own .env; external secret stores are unavailable")
        return native_dotenv(hermes_home=account_home, project_env=None, load_external_secrets=False)
    env_loader.load_hermes_dotenv = own_dotenv
    from hermes_cli.main import main
    raise SystemExit(main())
finally:
    if release is not None:
        release()
