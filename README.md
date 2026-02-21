# Claude Code Review

VS Code / Cursor расширение для интерактивного code review изменений, сделанных Claude CLI. Управление сессиями Claude, просмотр diff, принятие/откат изменений по отдельным hunk-ам — всё в боковой панели редактора.

## Возможности

- **Code Review** — интерактивный diff с кнопками Keep / Undo на каждый hunk прямо в редакторе (CodeLens)
- **Сессии Claude** — запуск и управление несколькими Claude CLI сессиями через встроенный терминал (xterm.js + node-pty)
- **Автозахват изменений** — PostToolUse hook автоматически отслеживает файлы, которые Claude редактирует через Edit/Write
- **Навигация** — переход между файлами и hunk-ами, статус-бар с контекстными действиями
- **Отправка контекста** — отправка выделенного кода или файла в активную сессию Claude (`Alt+K`)

## Требования

- VS Code `≥ 1.100.0` или Cursor
- Claude CLI (`claude`) установлен и доступен в PATH
- Git

## Установка

Сборка не требуется — расширение написано на чистом JavaScript без зависимостей.

Скопируйте содержимое репозитория в папку расширений:

```bash
# Для Cursor и VS Code одновременно:
cp -r /path/to/claude-code-review/* ~/.cursor/extensions/local.claude-code-review-8.0.0/
cp -r /path/to/claude-code-review/* ~/.vscode/extensions/local.claude-code-review-8.0.0/
```

> **Важно:** имя папки должно соответствовать формату `local.claude-code-review-<version>/`, где version совпадает с `version` в `package.json`. После копирования перезапустите редактор.

## Использование

### Быстрый старт

1. Откройте боковую панель **Claude Code Review** (иконка в Activity Bar или `Ctrl+Alt+B`)
2. Нажмите **New Session** для запуска Claude CLI в встроенном терминале
3. Работайте с Claude — изменённые файлы автоматически появятся в очереди на review
4. Просматривайте diff, принимайте или откатывайте изменения по hunk-ам

### Горячие клавиши

| Комбинация | Действие |
|---|---|
| `Ctrl+Alt+B` | Показать/скрыть панель |
| `Alt+K` | Отправить выделение в сессию Claude |

### Команды

Все команды доступны через Command Palette (`Ctrl+Shift+P`):

- `Claude Code Review: Toggle Panel` — показать/скрыть панель
- `Claude Code Review: Start Review` — начать review
- `Claude Code Review: Keep All Changes` / `Undo All Changes` — принять/откатить все
- `Claude Code Review: New Claude Session` — новая сессия
- `Claude Code Review: Install Hook` — установить PostToolUse hook
- `Claude Code Review: Send Selection to Session` — отправить выделение
- `Claude Code Review: Previous/Next File` — навигация по файлам
- `Claude Code Review: Previous/Next Change` — навигация по hunk-ам

### Hook

При первом запуске расширение предложит установить PostToolUse hook в `.claude/hooks/`. Hook отслеживает вызовы Edit/Write инструментов Claude и отправляет пути изменённых файлов на локальный HTTP-сервер расширения (порт `27182`).

## Архитектура

```
Claude CLI (PTY)
    │  PostToolUse hook (Edit/Write)
    ▼
Hook Script (.claude/hooks/ccr-review-hook.sh)
    │  HTTP POST /changed
    ▼
HTTP Server (port 27182)
    │  addFileToReview()
    ▼
State (activeReviews Map)
    │
    ├──→ CodeLens Provider (Keep/Undo кнопки в редакторе)
    ├──→ Decorations (подсветка добавленных/удалённых строк)
    └──→ Webview Sidebar (терминал + список файлов на review)
```

### Структура проекта

```
├── extension.js          — точка входа, регистрация команд
├── package.json          — манифест расширения
├── lib/
│   ├── main-view.js      — WebviewViewProvider (sidebar UI + терминал)
│   ├── actions.js        — workflow review (accept/reject hunk/file/all)
│   ├── review.js         — модель FileReview, слияние hunk-ов
│   ├── diff.js           — парсинг unified diff, работа с git
│   ├── hook-manager.js   — установка и валидация hook-скрипта
│   ├── pty-manager.js    — управление PTY-сессиями (node-pty)
│   ├── sessions.js       — обнаружение существующих сессий Claude
│   ├── server.js         — HTTP-сервер (мост для hook)
│   ├── state.js          — централизованное состояние
│   ├── codelens.js       — CodeLens провайдер
│   ├── decorations.js    — декорации редактора
│   ├── status-bar.js     — контекстный статус-бар
│   └── log.js            — логирование
└── media/
    ├── icon.svg          — иконка расширения
    ├── xterm.min.js      — терминал xterm.js
    ├── xterm.css         — стили xterm
    └── addon-fit.min.js  — addon для авторесайза терминала
```

## Настройки

| Параметр | По умолчанию | Описание |
|---|---|---|
| `claudeCodeReview.cliCommand` | `claude` | CLI команда для сессий (`claude` или `happy`) |

## Разработка

Для внесения изменений:

1. Отредактируйте файлы в репозитории
2. Скопируйте в папку расширений:
   ```bash
   cp -r ./* ~/.cursor/extensions/local.claude-code-review-8.0.0/
   cp -r ./* ~/.vscode/extensions/local.claude-code-review-8.0.0/
   ```
3. Перезапустите редактор (`Developer: Reload Window`)

Сборка не требуется — все изменения применяются сразу после копирования и перезагрузки.
