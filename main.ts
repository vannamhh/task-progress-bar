import {
	Plugin,
	WorkspaceLeaf,
	View,
	TFile,
	Notice,
	MarkdownView,
	App,
	PluginSettingTab,
	Setting,
	MetadataCache,
	Vault
} from "obsidian";

// Increased wait time for file sync
const FILE_SYNC_WAIT_TIME = 10000; // 10 seconds wait for file sync

interface ProgressBarSettings {
	barColor: string;
	barHeight: number;
	showTaskCount: boolean;
}

const DEFAULT_SETTINGS: ProgressBarSettings = {
	barColor: "#5e81ac",
	barHeight: 20,
	showTaskCount: true,
};

export default class ProgressBarPlugin extends Plugin {
	settings: ProgressBarSettings;
	private updateTimeout: NodeJS.Timeout | null = null;
	private lastFileContent: string = "";
	private lastFile: string | null = null;
	private vault: Vault;
	private metadataCache: MetadataCache;

	async onload() {
		console.log("Loading Progress Bar Sidebar plugin");
		
		// Store references to vault and metadata cache for easier access
		this.vault = this.app.vault;
		this.metadataCache = this.app.metadataCache;

		await this.loadSettings();

		// Register view type
		this.registerView(
			"progress-bar-view",
			(leaf) => new ProgressBarView(leaf, this)
		);

		// Add icon to ribbon menu
		this.addRibbonIcon(
			"bar-chart-horizontal",
			"Show Task Progress Bar",
			async () => {
				await this.activateView();
			}
		);

		// Add command to show progress bar
		this.addCommand({
			id: "show-task-progress-bar",
			name: "Show Task Progress Bar",
			callback: async () => {
				await this.activateView();
			},
		});

		// Add command to refresh progress bar
		this.addCommand({
			id: "refresh-task-progress-bar",
			name: "Refresh Task Progress Bar",
			callback: async () => {
				new Notice("Refreshing progress bar...");
				this.scheduleUpdate(true);
			},
		});

		// Activate view when layout is ready
		this.app.workspace.onLayoutReady(() => {
			this.activateView();
		});

		// Register for file changes
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file) {
					this.lastFile = file.path;
					this.scheduleUpdate();
				}
			})
		);

		// Register for editor changes
		this.registerEvent(
			this.app.workspace.on("editor-change", (editor, view) => {
				if (view && view.file) {
					this.lastFile = view.file.path;
					// Get content directly from editor for immediate feedback
					this.lastFileContent = editor.getValue();
					this.scheduleUpdate(false, true);
				}
			})
		);

		// Handle checkbox clicks with a more robust approach
		this.registerDomEvent(document, "click", (evt: MouseEvent) => {
			const target = evt.target as HTMLElement;
			const isCheckbox =
				target.matches(".task-list-item-checkbox") ||
				target.matches('input[type="checkbox"]');

			if (isCheckbox || target.closest("li.task-list-item")) {
				// Force a full refresh after checkbox clicks
				this.scheduleUpdate(true);
			}
		});

		// Listen for metadata changes - this is crucial for reading view
		this.registerEvent(
			this.metadataCache.on("changed", (file) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile && activeFile.path === file.path) {
					this.lastFile = file.path;
					// Clear cached content to force a fresh read
					this.lastFileContent = "";
					this.scheduleUpdate(true);
				}
			})
		);

		// Add settings tab
		this.addSettingTab(new ProgressBarSettingTab(this.app, this));
	}

	// Improved update scheduler
	scheduleUpdate(forceSync = false, useEditorContent = false) {
		// Clear any existing timeout
		if (this.updateTimeout) {
			clearTimeout(this.updateTimeout);
		}

		// Set a new timeout with appropriate delay
		this.updateTimeout = setTimeout(() => {
			this.updateProgressBar(useEditorContent);
		}, forceSync ? FILE_SYNC_WAIT_TIME : 500);
	}

	// Count tasks in content
	countTasks(content: string): { total: number; completed: number } {
		if (!content) {
			return { total: 0, completed: 0 };
		}

		// Improved regex for Obsidian task format
		const taskLineRegex = /^\s*[-*+] \[([ xX#\->/])\](?!\()/gm;

		try {
			const matches = [...content.matchAll(taskLineRegex)];
			const total = matches.length;
			let completed = 0;

			for (const match of matches) {
				// Get character inside brackets
				const checkChar = match[1];
				// Consider completed if not a space
				if (checkChar !== " ") {
					completed++;
				}
			}

			return { total, completed };
		} catch (e) {
			console.error("Error counting tasks:", e);
			return { total: 0, completed: 0 };
		}
	}

	// Improved file content retrieval
	private async getFileContent(useEditorContent = false): Promise<{ file: TFile | null; content: string }> {
		const currentFile = this.app.workspace.getActiveFile();
		
		// If no file is open, return empty content
		if (!currentFile) {
			return { file: null, content: "" };
		}

		// For editor view, get content directly from editor if requested
		if (useEditorContent) {
			const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (mdView?.editor && mdView.file === currentFile) {
				return { 
					file: currentFile, 
					content: mdView.editor.getValue() 
				};
			}
		}

		try {
			// Always read directly from vault for most accurate content
			const content = await this.vault.read(currentFile);
			return { file: currentFile, content };
		} catch (e) {
			console.warn("Error reading file:", e);
			// Fallback to cached content if available
			if (this.lastFile === currentFile.path && this.lastFileContent) {
				return { file: currentFile, content: this.lastFileContent };
			}
			// Last resort - try cached read
			try {
				const content = await this.vault.cachedRead(currentFile);
				return { file: currentFile, content };
			} catch (err) {
				console.error("Failed to read file content:", err);
				return { file: currentFile, content: "" };
			}
		}
	}

	// Main update method - improved
	async updateProgressBar(useEditorContent = false) {
		try {
			// Get progress bar views
			const leaves = this.app.workspace.getLeavesOfType("progress-bar-view");
			if (leaves.length === 0) {
				return;
			}

			// Get file content and count tasks
			const { file, content } = await this.getFileContent(useEditorContent);
			if (!file) {
				// No file open, update views to show "no file" message
				for (const leaf of leaves) {
					const view = leaf.view;
					if (view instanceof ProgressBarView) {
						view.showNoFileMessage();
					}
				}
				return;
			}

			// Cache the content for future use
			this.lastFileContent = content;
			this.lastFile = file.path;

			// Count tasks
			const { total, completed } = this.countTasks(content);

			// Update all progress bar views
			for (const leaf of leaves) {
				const view = leaf.view;
				if (view instanceof ProgressBarView) {
					view.updateProgress(file, total, completed);
				}
			}
		} catch (error) {
			console.error("Error updating progress bar:", error);
			new Notice("Error updating progress bar");
		}
	}

	async onunload() {
		// Clear any pending timeout
		if (this.updateTimeout) {
			clearTimeout(this.updateTimeout);
		}

		console.log("Unloading Progress Bar Sidebar plugin");
		this.app.workspace.detachLeavesOfType("progress-bar-view");
	}

	async activateView() {
		const { workspace } = this.app;

		// Check if view already exists
		const leaves = workspace.getLeavesOfType("progress-bar-view");
		if (leaves.length > 0) {
			workspace.revealLeaf(leaves[0]);
			return;
		}

		// Create new leaf in right sidebar
		let leaf = workspace.getRightLeaf(false);
		if (!leaf) {
			if (!workspace.rightSplit) {
				new Notice("Please open the right sidebar first");
				return;
			}
			leaf = workspace.getLeaf("split", "vertical");
			if (workspace.rightSplit) {
				leaf.parent = workspace.rightSplit;
			}
		}

		// Set up view
		await leaf.setViewState({
			type: "progress-bar-view",
			active: true,
		});

		// Reveal leaf
		workspace.revealLeaf(leaf);

		// Update progress bar
		this.scheduleUpdate();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// Simple view class for displaying progress
class ProgressBarView extends View {
	plugin: ProgressBarPlugin;
	private fileNameEl: HTMLElement | null = null;
	private progressContainerEl: HTMLElement | null = null;
	contentEl: HTMLElement;

	constructor(leaf: WorkspaceLeaf, plugin: ProgressBarPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	async onOpen(): Promise<void> {
		try {
			// Create contentEl if it doesn't exist
			if (!this.contentEl) {
				this.contentEl = this.containerEl.createDiv("view-content");
			}

			// Set up the view
			this.contentEl.empty();
			this.contentEl.addClass("progress-bar-view");

			// Add some CSS for better styling
			this.contentEl.createEl("style", {
				text: `
					.progress-bar-view {
						padding: 10px;
					}
					.progress-bar-title {
						margin-top: 0;
						margin-bottom: 15px;
						text-align: center;
					}
					.file-name {
						font-weight: bold;
						margin-bottom: 10px;
						word-break: break-word;
					}
					.bar-container {
						height: ${this.plugin.settings.barHeight}px;
						background-color: #e0e0e0;
						border-radius: 4px;
						margin: 10px 0;
						overflow: hidden;
					}
					.bar {
						height: 100%;
						background-color: ${this.plugin.settings.barColor};
						transition: width 0.3s ease;
					}
					.progress-label {
						font-weight: bold;
						text-align: center;
						margin: 5px 0;
					}
					.task-count-info {
						text-align: center;
						font-size: 0.9em;
						color: var(--text-muted);
					}
					.no-file-info, .no-tasks-info {
						text-align: center;
						color: var(--text-muted);
						margin-top: 20px;
					}
					.error-message {
						color: var(--text-error);
						padding: 10px;
						border: 1px solid var(--background-modifier-error);
						border-radius: 4px;
						margin-top: 10px;
					}
				`
			});

			// Create fixed elements
			this.contentEl.createEl("h4", {
				text: "Task Progress",
				cls: "progress-bar-title",
			});

			// Create elements to be updated later
			this.fileNameEl = this.contentEl.createDiv("file-info");
			this.progressContainerEl = this.contentEl.createDiv("progress-container");

			// Initial state when no file is open
			this.showNoFileMessage();

			// Request initial update
			setTimeout(() => {
				this.plugin.scheduleUpdate();
			}, 300);
		} catch (error) {
			console.error("Error in onOpen:", error);
			if (this.containerEl) {
				const errorDiv = this.containerEl.createDiv("error");
				errorDiv.setText(`Error: ${error.message || "Unknown"}`);
			}
		}
	}

	async onClose(): Promise<void> {
		// Nothing special needed here
	}

	getViewType(): string {
		return "progress-bar-view";
	}

	getDisplayText(): string {
		return "Task Progress";
	}

	getIcon(): string {
		return "bar-chart-horizontal";
	}

	showNoFileMessage(): void {
		if (!this.fileNameEl || !this.progressContainerEl) return;

		this.fileNameEl.empty();
		this.fileNameEl.createEl("div", {
			text: "No file open",
			cls: "file-name",
		});

		this.progressContainerEl.empty();
		this.progressContainerEl.createEl("div", {
			text: "Open a file to view task progress",
			cls: "no-file-info",
		});
	}

	updateProgress(file: TFile, totalTasks: number, completedTasks: number) {
		// Ensure UI elements exist
		if (!this.fileNameEl || !this.progressContainerEl || !this.contentEl) {
			return;
		}

		try {
			// Update file name
			this.fileNameEl.empty();
			this.fileNameEl.createEl("div", {
				text: file.name,
				cls: "file-name",
			});

			// Update progress container
			this.progressContainerEl.empty();

			if (totalTasks === 0) {
				this.progressContainerEl.createEl("div", {
					text: "No tasks found in this file",
					cls: "no-tasks-info",
				});
				return;
			}

			const percent = Math.round((completedTasks / totalTasks) * 100);

			// Create progress bar
			const barContainer = this.progressContainerEl.createDiv("bar-container");
			const bar = barContainer.createDiv("bar");
			bar.style.width = `${percent}%`;

			// Apply settings
			if (this.plugin.settings.barColor) {
				bar.style.backgroundColor = this.plugin.settings.barColor;
			}
			if (this.plugin.settings.barHeight) {
				barContainer.style.height = `${this.plugin.settings.barHeight}px`;
				bar.style.height = `${this.plugin.settings.barHeight}px`;
			}

			// Add percentage label
			this.progressContainerEl.createEl("div", {
				text: `${percent}% complete`,
				cls: "progress-label",
			});

			// Add task count if enabled in settings
			if (this.plugin.settings.showTaskCount) {
				this.progressContainerEl.createEl("div", {
					text: `${completedTasks} of ${totalTasks} tasks completed`,
					cls: "task-count-info",
				});
			}
		} catch (error) {
			console.error("Error updating progress bar:", error);
			this.displayError(error);
		}
	}

	private displayError(error: any) {
		if (!this.contentEl) return;

		this.contentEl.empty();
		this.contentEl.createEl("h4", { text: "Task Progress" });
		this.contentEl.createEl("div", {
			text: `Error: ${error?.message || "Unknown error"}`,
			cls: "error-message",
		});
	}
}

// Settings tab
class ProgressBarSettingTab extends PluginSettingTab {
	plugin: ProgressBarPlugin;

	constructor(app: App, plugin: ProgressBarPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Progress Bar Settings" });

		new Setting(containerEl)
			.setName("Bar Color")
			.setDesc("Set the color of the progress bar")
			.addText((text) =>
				text
					.setPlaceholder("#5e81ac")
					.setValue(this.plugin.settings.barColor || "")
					.onChange(async (value) => {
						this.plugin.settings.barColor = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Bar Height")
			.setDesc("Set the height of the progress bar in pixels")
			.addText((text) =>
				text
					.setPlaceholder("20")
					.setValue(String(this.plugin.settings.barHeight || ""))
					.onChange(async (value) => {
						const numValue = parseInt(value);
						if (!isNaN(numValue) && numValue > 0) {
							this.plugin.settings.barHeight = numValue;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Show Task Count")
			.setDesc("Show the number of completed tasks")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showTaskCount)
					.onChange(async (value) => {
						this.plugin.settings.showTaskCount = value;
						await this.plugin.saveSettings();
					})
			);
	}
}