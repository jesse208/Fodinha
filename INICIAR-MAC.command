#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then echo "Instale o Node.js em https://nodejs.org"; read -n1; exit; fi
(sleep 2; open http://localhost:3000) &
node server.js
