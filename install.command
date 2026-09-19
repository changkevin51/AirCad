#!/bin/zsh
# Double-click in Finder to install Python and web UI dependencies.
cd -- "${0:A:h}" || exit 1

fail() {
    print "\nDependency install failed. See the messages above."
    read -r '?Press Return to close...'
    exit 1
}

if [[ ! -x .venv/bin/python ]]; then
    if [[ -d .venv ]]; then
        print 'Replacing a virtual environment that is not usable on this Mac...'
        rm -rf .venv
    fi
    if command -v python3 >/dev/null 2>&1; then
        python3 -m venv .venv || fail
    else
        print 'Could not create a virtual environment.'
        print 'Install Python 3.10, 3.11, or 3.12 from https://www.python.org/downloads/'
        read -r '?Press Return to close...'
        exit 1
    fi
fi

.venv/bin/python -m pip install -U pip || fail
.venv/bin/python -m pip install -r requirements.txt || fail

if ! command -v node >/dev/null 2>&1; then
    print '\nNode.js was not found. Install Node 18 or newer from https://nodejs.org/'
    print 'then run this file again so the web UI can be built.'
    read -r '?Press Return to close...'
    exit 1
fi

print '\nInstalling the web UI...'
(
    cd web
    npm install && npm run build
) || fail

print '\nSetup finished. Double-click "Start AirCAD.command" to run the app.'
read -r '?Press Return to close...'
exit 0
