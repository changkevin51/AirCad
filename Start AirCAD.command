#!/bin/zsh
# Double-click in Finder to run AirCAD with this project's installed dependencies.
cd -- "${0:A:h}" || exit 1
if [[ ! -x .venv/bin/python ]]; then
    print 'Install the dependencies using README.md or double-click install.command, then try again.'
    read -r '?Press Return to close...'
    exit 1
fi
if [[ ! -f web/dist/index.html ]]; then
    print 'The web UI is not built yet. Double-click install.command, then try again.'
    read -r '?Press Return to close...'
    exit 1
fi
.venv/bin/python -u server.py "$@"
aircad_exit=$?
if (( aircad_exit != 0 )); then
    print '\nIf macOS asked for camera access, click Allow and double-click this file again.'
    print 'Use --no-camera to sketch with the mouse only.'
    read -r '?Press Return to close...'
fi
exit "$aircad_exit"
