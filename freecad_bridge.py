"""Small, asynchronous bridge from AirCAD sketch entities to the FreeCAD GUI.

The server process only imports this module's standard-library code.  FreeCAD
is launched as a separate process and imports :mod:`freecad_import` itself,
so no FreeCAD package is required in the AirCAD virtual environment.

Entities are millimetre geometry produced by the web UI::

    {"type": "line", "points": [[x, y, z], [x, y, z]]}
    {"type": "rect", "points": [[x, y, z] * 4]}          # becomes a face
    {"type": "extrusion", "points": [[x, y, z] * 4], "vector": [dx, dy, dz]}  # solid
    {"type": "polyline", "points": [[x, y, z], ...]}      # open wire
"""

from __future__ import annotations

import json
import math
import numbers
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid
from typing import Any, Iterable, Mapping

from freecad_import import validated_extrusion_vector


PROJECT_ROOT = Path(__file__).resolve().parent
RUNTIME_DIR = PROJECT_ROOT / ".runtime"
SNAPSHOT_PATH = RUNTIME_DIR / "freecad_drawing.json"
FREECAD_IMPORT_SCRIPT = PROJECT_ROOT / "freecad_import.py"
SNAPSHOT_VERSION = 2

# A child process gets its own immutable snapshot path.  The canonical path is
# still updated on every send for inspection and for manual FreeCAD runs.
SNAPSHOT_ENV = "AIRCAD_FREECAD_SNAPSHOT"
FREECAD_EXECUTABLE_ENV = "FREECAD_EXECUTABLE"
_SNAPSHOT_LOCK = threading.Lock()

ENTITY_POINT_COUNTS = {"line": (2, 2), "rect": (4, 4), "polyline": (2, None), "extrusion": (4, 4)}


def _numeric(value: object) -> int | float:
    """Return a JSON-safe finite number, rejecting booleans and NaN/Inf."""

    if isinstance(value, bool) or not isinstance(value, numbers.Number):
        raise ValueError("coordinates must be numeric")
    try:
        converted = float(value)
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError("coordinates must be numeric") from error
    if not math.isfinite(converted):
        raise ValueError("coordinates must be finite")
    if converted.is_integer():
        return int(converted)
    return converted


def _point(value: object) -> list[int | float]:
    """Accept ``[x, y]`` or ``[x, y, z]`` and always return three coordinates."""

    try:
        coordinates = list(value)  # type: ignore[arg-type]
    except TypeError as error:
        raise ValueError("each point must contain two or three coordinates") from error
    if len(coordinates) == 2:
        coordinates.append(0)
    if len(coordinates) != 3:
        raise ValueError("each point must contain two or three coordinates")
    return [_numeric(coordinate) for coordinate in coordinates]


def normalize_entity(entity: object) -> dict[str, Any]:
    """Validate one entity mapping and return its JSON-ready form."""

    if not isinstance(entity, Mapping):
        raise ValueError("each entity must be a mapping with 'type' and 'points'")
    kind = str(entity.get("type", "")).lower()
    if kind not in ENTITY_POINT_COUNTS:
        raise ValueError("unsupported entity type: {!r}".format(entity.get("type")))
    try:
        raw_points = list(entity.get("points", ()))
    except TypeError as error:
        raise ValueError("entity points must be a list of points") from error
    minimum, maximum = ENTITY_POINT_COUNTS[kind]
    if len(raw_points) < minimum or (maximum is not None and len(raw_points) > maximum):
        raise ValueError("a {} needs {} points".format(kind, minimum if maximum == minimum else f"at least {minimum}"))
    points = [_point(point) for point in raw_points]
    normalized: dict[str, Any] = {"type": kind, "points": points}
    if kind == "extrusion":
        vector = entity.get("vector")
        if not isinstance(vector, (list, tuple)) or len(vector) != 3:
            raise ValueError("an extrusion needs a three-coordinate vector")
        normalized["vector"] = list(validated_extrusion_vector(points, [_numeric(value) for value in vector]))
    if entity.get("id") is not None:
        normalized["id"] = str(entity["id"])
    return normalized


def _snapshot_entities(entities: Iterable[object]) -> list[dict[str, Any]]:
    try:
        values = iter(entities)
    except TypeError as error:
        raise ValueError("entities must be an iterable of entity mappings") from error
    return [normalize_entity(entity) for entity in values]


def _atomic_write(path: Path, payload: bytes) -> None:
    """Write a complete file and replace the destination atomically."""

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_name = temporary.name
            temporary.write(payload)
            temporary.flush()
        os.replace(temporary_name, path)
        temporary_name = None
    finally:
        if temporary_name is not None:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass


def _windows_search_roots() -> tuple[Path, ...]:
    roots: list[Path] = []
    for key in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
        value = os.environ.get(key)
        if value:
            roots.append(Path(value))
    return tuple(roots)


def _windows_freecad_install_executables() -> tuple[Path, ...]:
    """Discover typical Windows installer locations without requiring PATH."""

    found: list[Path] = []
    for root in _windows_search_roots():
        found.extend(sorted(root.glob("FreeCAD*/bin/FreeCAD.exe"), reverse=True))
        found.extend(sorted(root.glob("FreeCAD*/bin/freecad.exe"), reverse=True))
    unique: list[Path] = []
    seen: set[str] = set()
    for path in found:
        key = str(path).casefold()
        if key not in seen:
            seen.add(key)
            unique.append(path)
    return tuple(unique)


def _freecad_candidates() -> tuple[Path | str, ...]:
    if os.name == "nt":
        return _windows_freecad_install_executables() + ("FreeCAD.exe", "freecad.exe")
    if sys_platform_is_macos():
        return (
            Path("/Applications/FreeCAD.app/Contents/MacOS/FreeCAD"),
            "FreeCAD",
            "freecad",
        )
    return ("FreeCAD", "freecad")


def sys_platform_is_macos() -> bool:
    """Keep platform lookup patchable in tests without importing platform code."""

    return sys.platform == "darwin"


def _resolve_executable(candidate: Path | str) -> Path | str | None:
    value = str(candidate)
    path = Path(value).expanduser()
    if path.is_absolute() or os.sep in value or (os.altsep and os.altsep in value):
        if path.is_file() and (os.name == "nt" or os.access(path, os.X_OK)):
            return path
        return None
    return shutil.which(value)


def _find_freecad() -> Path | str:
    override = os.environ.get(FREECAD_EXECUTABLE_ENV) or os.environ.get(
        "AIRCAD_FREECAD_EXECUTABLE"
    )
    if override:
        resolved = _resolve_executable(override)
        if resolved is None:
            raise OSError(
                f"FreeCAD executable override does not exist or is not executable: {override}"
            )
        return resolved

    for candidate in _freecad_candidates():
        resolved = _resolve_executable(candidate)
        if resolved is not None:
            return resolved
    raise OSError(
        "FreeCAD GUI executable was not found; set FREECAD_EXECUTABLE to its path"
    )


def _launch_freecad(snapshot: Path) -> None:
    executable = _find_freecad()
    if not FREECAD_IMPORT_SCRIPT.is_file():
        raise OSError(f"FreeCAD importer is missing: {FREECAD_IMPORT_SCRIPT}")

    importer = FREECAD_IMPORT_SCRIPT.resolve()
    macro = snapshot.with_suffix(".FCMacro")
    macro_source = """# AirCAD snapshot launcher; generated for one send.\n""" + (
        "import importlib.util\n"
        "from pathlib import Path\n"
        f"_importer = Path({str(importer)!r})\n"
        f"_snapshot = Path({str(snapshot.resolve())!r})\n"
        "_spec = importlib.util.spec_from_file_location('_aircad_freecad_import', _importer)\n"
        "if _spec is None or _spec.loader is None:\n"
        "    raise RuntimeError('could not load AirCAD FreeCAD importer')\n"
        "_module = importlib.util.module_from_spec(_spec)\n"
        "_spec.loader.exec_module(_module)\n"
        "_module.main(_snapshot)\n"
    )
    _atomic_write(macro, macro_source.encode("utf-8"))

    child_environment = os.environ.copy()
    child_environment[SNAPSHOT_ENV] = str(snapshot)
    try:
        # FreeCAD executes an .FCMacro before entering the normal GUI event
        # loop.  --single-instance also forwards that macro to an existing GUI
        # session, where a positional script is not reliably re-imported.
        subprocess.Popen(
            [str(executable), "--single-instance", str(macro)],
            cwd=str(PROJECT_ROOT),
            env=child_environment,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as error:
        raise OSError(f"could not start FreeCAD GUI: {error}") from error


def send_to_freecad(entities: Iterable[object]) -> Path:
    """Snapshot sketch entities (mm) and asynchronously open them in FreeCAD.

    The returned path is always the project-relative runtime snapshot
    ``.runtime/freecad_drawing.json``.  Each process receives a separate hidden
    snapshot path through ``AIRCAD_FREECAD_SNAPSHOT`` so a later send cannot
    change what an earlier FreeCAD process imports.
    """

    normalized = _snapshot_entities(entities)
    if not normalized:
        raise ValueError("at least one entity is required")
    payload = json.dumps(
        {"version": SNAPSHOT_VERSION, "units": "mm", "entities": normalized},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")

    with _SNAPSHOT_LOCK:
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        unique_snapshot = RUNTIME_DIR / f"freecad_drawing_{uuid.uuid4().hex}.json"
        _atomic_write(unique_snapshot, payload)
        _atomic_write(SNAPSHOT_PATH, payload)
        _launch_freecad(unique_snapshot)
    return SNAPSHOT_PATH


__all__ = ["normalize_entity", "send_to_freecad"]
