#!/usr/bin/env bash
# Sync erawan static UI from the repo to the nginx docroot (/var/www/erawan).
# nginx can't read the repo under /home/ubuntu (home is 0750, guards world-readable secrets),
# so the static file is served from a copy. Run this after editing ui/.
set -e
sudo cp "$(dirname "$0")/ui/index.html" /var/www/erawan/index.html
sudo chown www-data:www-data /var/www/erawan/index.html
echo "erawan UI synced -> /var/www/erawan/index.html"
