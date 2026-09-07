# Vex Studio

The engineering source of truth for Vex Studio (the local MCP host, the `vex-mcp` bridge, the
installer and the guides it writes, the studio_mcp tool surface, approvals from an external agent,
projects and files, the in-app workspace, sessions and logging, configuration, limits and error
codes) is the repository-level document [`VEX_STUDIO.md`](../../../VEX_STUDIO.md). It is written
from the code with `path:line` citations and is regenerated per its own "Keeping This Document
Current" appendix when the code moves. The landing site's Studio pages and the in-app "How Vex
Works" Studio section are derived from it, never the other way round.

This directory owns the agent roster (`agents.ts`) and the installer's rendered instruction files
(`installer/`, `instructions/`); see the document's Part 6 for how they are reconciled on disk.
