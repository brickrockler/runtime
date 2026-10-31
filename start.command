#!/bin/bash
cd "$(dirname "$0")/public"
open "http://127.0.0.1:8788"
python3 -m http.server 8788 --bind 127.0.0.1
