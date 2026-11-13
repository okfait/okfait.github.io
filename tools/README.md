# tools

## Rebuilding the styles (`assets/css/tailwind.css`)

The site used to load Tailwind from the internet and build styles live in the
browser. That is slow and keeps eating memory, so now the styles are built once
into `assets/css/tailwind.css`.

**What this means for you:** if you add a NEW Tailwind class (like `bg-pink-500`)
to `index.html` or any file in `assets/js/`, it will not show up until you rebuild:

```
npm install --no-save tailwindcss@3.4.17
npx tailwindcss -c tools/tailwind.config.js -i tools/tailwind-input.css -o assets/css/tailwind.css --minify
```

(Run it from the repo's main folder, then commit the new `assets/css/tailwind.css`.)
Classes that already exist keep working without a rebuild.
