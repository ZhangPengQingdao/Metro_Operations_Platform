# Platform icon resources

`PlatformIcon` is part of L2 and is exported by `src/components/ui/index.ts`.

The SVG path data is copied from the user-provided OmegAI reference at `frontend/src/components/icons/Icon.vue`; `users` comes from `frontend/src/components/layout/AppSidebar.vue` (`UsersIcon`). The adapter only changes Vue rendering into React SVG elements. It preserves the original 24×24 viewBox, round line caps/joins and 1.5px stroke. `grid` is the same path as `DashboardIcon` in `icons/navigation.ts`.

Use `<PlatformIcon name="panelLeft" size={20} />`. Supported names are available as `PLATFORM_ICON_NAMES`; the L2 developer catalogue shows every resource. Icons inherit `currentColor` and are decorative by default; the enclosing link or button must carry its accessible name. No raw SVG injection or dynamic network icon loader is used.

This set complements the existing transport icon library. Admin sidebar, personal menu, notification, search and login controls share these resources.

- `arrowLeft`: copied from OmegAI `frontend/src/components/icons/Icon.vue`, used for returning to primary navigation.
