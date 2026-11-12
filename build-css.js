// Пересобирает assets/tailwind.css из классов, найденных в fizai/index.html
// Запуск: node build-css.js
const { execSync } = require('child_process');

execSync(
    'npx --yes tailwindcss@3.4.17 -c tailwind.config.js -i tailwind.input.css -o assets/tailwind.css --minify',
    { cwd: __dirname, stdio: 'inherit' }
);
