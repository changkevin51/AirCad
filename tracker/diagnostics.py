"""Optional bounded diagnostics for depth tracking.

``--tracking-debug`` enables a rotating JSONL log under ``.runtime/``; it is
disabled by default and records only measurements and transitions (never
images, landmark dumps, or secrets).  All logging I/O failures are contained
here so a broken log can never take tracking down with it.
"""

from __future__ import annotations

import json
import logging
import logging.handlers
import math
import numbers
from pathlib import Path
from typing import Any, Optional


RUNTIME_DIR = Path(__file__).resolve().parent.parent / ".runtime"
LOG_PATH = RUNTIME_DIR / "depth-tracking.jsonl"
MAX_LOG_BYTES = 5 * 1024 * 1024
LOG_BACKUPS = 2
_MAX_IO_ERRORS = 1_000_000
_MAX_EVENTS = 1_000_000


class _CountedRotatingHandler(logging.handlers.RotatingFileHandler):
    """Rotating JSONL sink whose emit failures bump a bounded counter."""

    def __init__(self, *args, on_error=None, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._on_error = on_error

    def handleError(self, record) -> None:
        if self._on_error is not None:
            self._on_error()


def _sanitize(value: Any) -> Any:
    """Coerce log fields into finite JSON-safe values (NaN/Inf become null)."""

    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, numbers.Integral):
        return int(value)
    if isinstance(value, numbers.Real):
        number = float(value)
        return number if math.isfinite(number) else None
    if isinstance(value, dict):
        return {str(key): _sanitize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_sanitize(item) for item in value]
    return str(value)


class TrackingDiagnostics:
    """Bounded rotating JSONL logger; a no-op cost when disabled."""

    def __init__(
        self,
        path: Optional[Path] = None,
        *,
        enabled: bool = True,
        max_bytes: int = MAX_LOG_BYTES,
        backups: int = LOG_BACKUPS,
    ) -> None:
        self.path = Path(path) if path is not None else LOG_PATH
        self.enabled = bool(enabled)
        self.events = 0
        self.io_errors = 0
        self._logger: Optional[logging.Logger] = None
        if self.enabled:
            self._open(max_bytes, backups)

    def _count_io_error(self) -> None:
        if self.io_errors < _MAX_IO_ERRORS:
            self.io_errors += 1

    def _open(self, max_bytes: int, backups: int) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            handler = _CountedRotatingHandler(
                self.path,
                maxBytes=int(max_bytes),
                backupCount=int(backups),
                encoding="utf-8",
                on_error=self._count_io_error,
            )
            handler.setFormatter(logging.Formatter("%(message)s"))
            logger = logging.getLogger("aircad.depth_tracking.{}".format(id(self)))
            logger.setLevel(logging.INFO)
            logger.propagate = False
            logger.addHandler(handler)
            self._logger = logger
        except Exception:
            self._logger = None
            self._count_io_error()

    def log(self, event: str, **fields: Any) -> None:
        """Append one sanitized JSON record; failures are counted, not raised."""

        if not self.enabled:
            return
        if self.events < _MAX_EVENTS:
            self.events += 1
        if self._logger is None:
            return
        record = {"event": str(event)}
        record.update(_sanitize(fields))
        try:
            line = json.dumps(record, separators=(",", ":"), allow_nan=False)
            self._logger.info(line)
        except Exception:
            self._count_io_error()

    def close(self) -> None:
        logger, self._logger = self._logger, None
        if logger is None:
            return
        try:
            for handler in list(logger.handlers):
                logger.removeHandler(handler)
                handler.close()
        except Exception:
            self._count_io_error()


__all__ = [
    "LOG_BACKUPS",
    "LOG_PATH",
    "MAX_LOG_BYTES",
    "RUNTIME_DIR",
    "TrackingDiagnostics",
]
