# Readiness capture

`nexo-idle.txt` is the unmodified QA capture from Nexo 033 on 2026-09-06.
SHA-256: `9a1d9d0afc06ab9b3121a83da8c9a826812845acccefa89af217c2eaa2102870`.
Origin: `.artifacts/eval-033-final/gating/nexo-check.txt` in the historical
checkout. It contains QA-only output, not credentials. Preserve bytes, including
trailing spaces. The test checks the hash before using the capture.

The terminal has an empty Pi composer and Luna footer. Earlier tool output ends
in `cat >`; those lines are transcript, not an active shell prompt.
