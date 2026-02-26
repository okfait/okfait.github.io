# 🧭 okMUSIC Project Guidelines

> Rules for maintaining the okMUSIC codebase.

## 1. Versioning Rule

Every update **MUST** increment the version number in exactly two places:

1. `index.html`: Line 6 (inside the `<title>` tag).
2. `okmusic_version_memory.txt`: Line 2.

Follow the `[Major].[Minor].[Patch]` format:

- **Major**: Significant architecture changes.
- **Minor**: New features (e.g., Party Mode additions).
- **Patch**: Bug fixes, UI tweaks, and syntax corrections.

## 2. Code Standards

- **Class Methods**: inside `class UI` or `class PartyMode`, do NOT use commas between methods.
- **Glassmorphism**: Always use `backdrop-filter: blur(8px) saturate(110%)` for premium panels.
- **Mobile First**: All new UI elements must be tested for responsiveness below 600px.

## 3. Deployment

Always run `git add index.html; git commit -m "vX.X.X: description"; git push` after verifying a new version.
