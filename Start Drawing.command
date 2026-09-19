#!/bin/zsh
# Double-click in Finder to run with this project's installed dependencies.
cd -- "${0:A:h}" || exit 1
if [[ ! -x .venv/bin/python ]]; then
    print 'Install the dependencies using README.md (python3 -m venv .venv), then try again.'
    read -r '?Press Return to close...'
    exit 1
fi
.venv/bin/python -u hand_tracker.py
drawing_exit=$?
if (( drawing_exit != 0 )); then
    print '\nIf macOS asked for camera access, click Allow and double-click this file again.'
    read -r '?Press Return to close...'
fi
exit "$drawing_exit"
