# Connection identity

Use `BrandLogo` for every product wordmark and `BrandMark` for an isolated symbol. Do not recreate the logo with text or CSS rings.

- `compact`, `standard` (default), and `large` use the same geometry, proportions, spacing, and medium weight.
- Inter: body 400, headings and wordmark 500, labels 600. JetBrains Mono remains for technical values.
- Symbol: ChainPay blue `#0052ff`; wordmark: ink `#14213d`. On a blue icon tile, use the white symbol.
- The two rounded hooks share a single path, rotated 180 degrees. Preserve the negative space and rounded ends when exporting.

The native SVG interprets the selected Connection concept; it is the implementation master. Public SVG and PNG exports live in `public/brand`. If geometry changes, update both SVG exports from `CONNECTION_PATH` and regenerate the 180, 192, and 512 pixel icon exports. Do not stretch or independently thicken small icons.

Receipt printing retains the inline vector and uses the same type weight with system fallback when Inter is unavailable. Keep its standalone CSS in `receipts/print.ts` aligned with `brand.css`.

Review the rendered family at `/test/fixtures/brand.html` in the development server. This specimen covers navigation, dashboard, receipt, and small icons.
