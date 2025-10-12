@echo off
echo Starting Etherpad...
cd src
set NODE_ENV=production
node --require tsx/cjs node/server.ts

