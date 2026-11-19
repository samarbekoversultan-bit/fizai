# FizAI Android (WebView)

Минимальный Android-проект, который оборачивает сайт https://fizai.netlify.app/ в нативное приложение (WebView).

## Как собрать APK

1. Установите **Android Studio** (https://developer.android.com/studio) — нужен JDK и Android SDK.
2. Откройте папку `fizai-android` в Android Studio: `File → Open → выберите папку`.
3. Дождитесь синхронизации Gradle (первый раз 2-5 минут, нужен интернет).
4. Соберите APK: `Build → Build Bundle(s) / APK(s) → Build APK(s)`.
5. Готовый APK появится в `app/build/outputs/apk/debug/app-debug.apk`.

## Установка на телефон
- Скопируйте APK на телефон и откройте (разрешите установку из неизвестных источников).
- Или подключите телефон по USB и нажмите Run в Android Studio.

## Особенности
- Загружает https://fizai.netlify.app/ в WebView с поддержкой JavaScript, localStorage, Firebase.
- Кнопка «Назад» возвращает на предыдущую страницу сайта.
- Внешние ссылки (не fizai.netlify.app) открываются в браузере.
- Интернет-разрешение уже добавлено.

## Обновление контента
Приложение грузит актуальную версию сайта из интернета, поэтому обновлять APK не нужно — достаточно обновить сайт на Netlify.
