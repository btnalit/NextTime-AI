#!/bin/sh
# Kernel purity guard (design doc graph-ai-middle-platform-design.md section 7.10): the kernel
# (packages/kernel/src) is mechanism, not content. It must never name a concrete system it talks
# to (docker, routeros, ...) - those names belong in gatekeepers/<system>/ (Operation manifests,
# policy, mappings) and ontology/<domain>/ (types, skills, procedures, workers) content packages,
# published through git/PR. A hit here means content has leaked into the mechanism layer.
#
# To extend the checked list, add a line (one extended regex per line, matched case-
# insensitively, no comment syntax of its own - see the header of that file) to
# scripts/system-names.txt.
#
# Run directly, via `pnpm ci:guards` (root package.json), `make ci`, or the CI `guards` job
# (.github/workflows/ci.yml).
set -eu

# S3.6 (docs/development-tasks.md W2-B) exemption: the MCP gateway's `interfaces/mcp/
# reference-tool-aliases.ts` documents and implements the Semantica MCP tool-name/required-param
# compatibility table the design doc's own §7.1 `mcp` module row mandates ("Semantica 工具名契约")
# and §9.3 requires ("Semantica 的 17 个工具名与必填参数作为契约保留") — this is a foreseen,
# design-mandated exception (a named reference contract this specific interfaces/mcp file exists
# to implement), not accidental content leakage into the mechanism layer. Every other consumer in
# packages/kernel/src (tool-projection.ts, server-factory.ts, index.ts, tests) deliberately never
# spells the name out — only this one file, whose entire purpose is that contract, is exempted.
if HITS=$(grep -rniE -f scripts/system-names.txt packages/kernel/src --exclude-dir=__fixtures__ --exclude='*.test.ts' --exclude='reference-tool-aliases.ts'); then
  echo "check-kernel-purity: concrete system name(s) found in packages/kernel/src (design doc section 7.10):" >&2
  echo "$HITS" >&2
  exit 1
fi

exit 0
