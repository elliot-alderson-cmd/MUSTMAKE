# CSS maintenance

- `style.css` is the shared stylesheet used by the pages. Shared design tokens, layout, component rules, responsive styles and theme overrides remain here so HTML classes and JavaScript-rendered class names continue to work.
- `profiles.css` contains profile-specific additions and is loaded by profile pages.
- `exercise-monitor.css` contains exercise-detail/monitor styles and is loaded only by exercise pages.

The removed CSS files were historical snapshots that were not referenced by any HTML, JavaScript or build configuration. Their global styles were already represented in `style.css`; keeping both copies invited editing the wrong file and maintaining stale duplicates.
