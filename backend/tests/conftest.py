import sys

import pytest


@pytest.fixture(autouse=True)
def _fresh_rate_limit_window():
    """main.py's limiter is one module-level object, and the TestClient's
    requests all come from the same address, so every /api/* call in the
    session shared one 30-per-minute budget. Once the suite's endpoint tests
    added up past 30, whichever test happened to run next got a 429 instead
    of its scan — an ordering failure that looked like a logging bug. Each
    test starts with an empty window instead. Only touches main.py if some
    test already imported it, so pure-logic tests stay light."""
    main = sys.modules.get("app.main")
    if main is not None:
        main.limiter._hits.clear()
    yield
