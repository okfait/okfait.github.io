// Tells Tailwind which files to scan for class names.
// (assets/css/tailwind.css is BUILT from this - see tools/README.md)
module.exports = {
  content: ["./index.html", "./assets/js/**/*.js"],
  theme: { extend: {} },
  plugins: [],
};
