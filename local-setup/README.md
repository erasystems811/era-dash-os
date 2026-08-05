# local-setup

One-time setup scripts for Chidera's own computer — not deployed anywhere,
these just make the ERA Dash OS panel's "Open terminal" links work locally.

## What this does

Each client in the panel has an **Open terminal** link. Clicking it opens
a real Windows Terminal window on your own computer, already sitting in
that business's local folder (`C:\Users\<you>\<business-slug>`) — never a
remote/web-based terminal, this only ever runs on your own machine.

## Setup (once per computer)

1. Copy `era-terminal-launcher.ps1` to `C:\Users\<you>\era-terminal-launcher.ps1`.
2. Run `register-eraterm-protocol.ps1` once (no admin rights needed).
3. Make sure the business's folder actually exists locally
   (`C:\Users\<you>\<business-slug>`) — clone its repo there if it doesn't yet.

After that, every client's "Open terminal" link in the panel just works.

## If you switch computers or reinstall Windows

Redo the two steps above on the new machine — everything else (the panel,
the businesses' actual code/servers) is unaffected, this is purely a local
convenience link.
