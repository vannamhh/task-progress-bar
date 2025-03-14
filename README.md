# Progress Bar Sidebar for Obsidian

This plugin displays a visual progress bar for tasks in your Markdown files directly on the Obsidian sidebar.

## Features

- 📊 **Displays visual progress bar** for tasks in the current file
- 🔢 **Shows completion percentage** and number of completed tasks
- ⚡ **Updates in real-time** when you check or uncheck tasks
- 📱 **Works in all viewing modes** (edit mode and reading mode)
- 🎨 **Customizable** colors and height of the progress bar

## Installation

### Install from Community Plugins

1. Open Obsidian
2. Go to Settings > Community plugins
3. Disable Safe Mode if it's enabled
4. Click "Browse" and search for "Progress Bar Sidebar"
5. Install the plugin and activate it

### Manual Installation

1. Create a folder `progress-bar-sidebar` in `.obsidian/plugins/`
2. Copy all plugin files into that folder
3. Restart Obsidian and activate the plugin in Settings > Community plugins

## How to Use

1. Click on the bar chart icon in the sidebar or use the "Show Task Progress Bar" command
2. Open a Markdown file containing task lists
3. The progress bar will automatically display the completion ratio of tasks

The plugin automatically tracks changes in the file and updates the progress bar when you check or uncheck tasks, both in edit mode and reading mode.

### Supported Task Syntax

The plugin supports standard Markdown and Obsidian task syntax:

```markdown
- [ ] Uncompleted task
- [x] Completed task
- [X] Also a completed task
- [/] In-progress task
- [-] Cancelled task
- [>] Deferred task
```

## Troubleshooting

If the progress bar doesn't display correctly in Reading View, please wait a few seconds for the plugin to automatically synchronize the state. The plugin is designed to automatically detect and fix inconsistencies between the interface and file content.

