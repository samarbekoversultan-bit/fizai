// Настройки Tailwind для сборки fizai/assets/tailwind.css
// Пересборка после правок классов в index.html:  node build-css.js
module.exports = {
    content: ['./index.html'],
    darkMode: 'class',
    theme: {
        extend: {
            colors: {
                dark: {
                    900: '#0b0f19',
                    800: '#111827',
                    700: '#1f2937',
                    600: '#374151',
                },
                primary: {
                    DEFAULT: '#6366f1',
                    hover: '#4f46e5',
                    light: '#818cf8',
                },
                accent: {
                    DEFAULT: '#06b6d4',
                    hover: '#0891b2',
                }
            },
            fontFamily: {
                sans: ['Inter', 'sans-serif'],
            }
        }
    }
};
