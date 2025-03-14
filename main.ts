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
	Vault,
} from "obsidian";

// Timing constants
const NORMAL_UPDATE_DELAY = 300; // ms for regular updates
const TASK_UPDATE_DELAY = 3000; // 3 seconds for task updates
const READING_VIEW_UPDATE_DELAY = 1500; // 1.5 seconds for reading view updates

// View type constant
const VIEW_TYPE_PROGRESS_BAR = "progress-bar-view";

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
	private view: ProgressBarView | null = null;
	private updateTimer: NodeJS.Timeout | null = null; // Fixed type to match setTimeout return type
	private lastFileContent: string | null = null;
	private lastFilePath: string | null = null;
	private isTaskUpdate = false; // Removed redundant type annotation
	private isReadingView = false; // Removed redundant type annotation

	private vault: Vault;
	private metadataCache: MetadataCache;

	async onload() {
		console.log("Loading Progress Bar Sidebar plugin");

		// Store references to vault and metadata cache for easier access
		this.vault = this.app.vault;
		this.metadataCache = this.app.metadataCache;

		await this.loadSettings();

		// Load styles
		this.loadStyles();

		// Register the custom view
		this.registerView(
			VIEW_TYPE_PROGRESS_BAR,
			(leaf: WorkspaceLeaf) =>
				(this.view = new ProgressBarView(leaf, this))
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
		this.app.workspace.onLayoutReady(this.initLeaf.bind(this));

		// Register for file changes
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file) {
					this.lastFilePath = file.path;
					this.checkViewMode();
					this.scheduleUpdate();
				}
			})
		);

		// Register for editor changes
		this.registerEvent(
			this.app.workspace.on("editor-change", (editor, view) => {
				if (view && view.file) {
					this.lastFilePath = view.file.path;
					this.isReadingView = false; // We're in editor mode
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
				// Check if we're in reading view
				this.checkViewMode();
				// Force a refresh after checkbox clicks
				this.scheduleUpdate(true);

				// For reading view, schedule additional updates to catch delayed changes
				if (this.isReadingView) {
					// Schedule multiple updates at different intervals
					setTimeout(() => this.scheduleUpdate(true), 1000);
					setTimeout(() => this.scheduleUpdate(true), 2500);
				}
			}
		});

		// Listen for metadata changes - this is crucial for reading view
		this.registerEvent(
			this.metadataCache.on("changed", (file) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile && activeFile.path === file.path) {
					this.lastFilePath = file.path;
					// Clear cached content to force a fresh read
					this.lastFileContent = "";
					this.scheduleUpdate();
				}
			})
		);

		// Listen for layout changes to detect reading/editing mode switches
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.checkViewMode();
				this.scheduleUpdate();
			})
		);

		// Add settings tab
		this.addSettingTab(new ProgressBarSettingTab(this.app, this));
	}

	// Load CSS styles
	loadStyles() {
		// Create a style element and add the CSS content directly
		const styleEl = document.createElement("style");
		styleEl.id = "progress-bar-sidebar-styles";

		// Add all the CSS styles inline
		styleEl.textContent = `
			/* Progress Bar Sidebar Plugin Styles */
			.progress-bar-view {
				padding: 10px !important;
				height: 120px !important;
				overflow: hidden !important;
			}
			
			.progress-bar-view .bar-container {
				background-color: #e0e0e0;
				border-radius: 4px;
				margin: 10px 0;
				overflow: hidden;
			}
			
			.progress-bar-view .bar {
				height: 100%;
				transition: width 0.3s ease;
			}
			
			.progress-bar-view .progress-label {
				font-weight: bold;
				text-align: center;
				margin: 5px 0;
			}
			
			.progress-bar-view .task-count-info {
				text-align: center;
				font-size: 0.9em;
				color: var(--text-muted);
			}
			
			.progress-bar-view .no-tasks-info {
				text-align: center;
				color: var(--text-muted);
				margin-top: 20px;
			}
			
			.progress-bar-view .error-message {
				color: var(--text-error);
				padding: 10px;
				border: 1px solid var(--background-modifier-error);
				border-radius: 4px;
				margin-top: 10px;
			}
		`;

		// Add the style element to the document head
		document.head.appendChild(styleEl);

		// Register cleanup to remove styles when plugin is unloaded
		this.register(() => styleEl.remove());
	}

	// Check if we're in reading view or editing view
	private checkViewMode() {
		const isReading =
			document.querySelector(".markdown-reading-view") !== null;
		if (isReading !== this.isReadingView) {
			this.isReadingView = isReading;
			// Clear cached content when switching modes
			this.lastFileContent = "";
		}
	}

	// Improved update scheduler
	scheduleUpdate(forceSync = false, useEditorContent = false) {
		// Clear any existing timeout
		if (this.updateTimer) {
			clearTimeout(this.updateTimer);
		}

		// Determine appropriate delay based on context
		let delay = NORMAL_UPDATE_DELAY;

		if (forceSync) {
			// Task updates need more time
			delay = TASK_UPDATE_DELAY;
		} else if (this.isReadingView && !useEditorContent) {
			// Reading view updates need a moderate delay
			delay = READING_VIEW_UPDATE_DELAY;
		}

		// Set a new timeout with appropriate delay
		this.updateTimer = setTimeout(() => {
			this.updateProgressBar(useEditorContent);
		}, delay);
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
	private async getFileContent(
		useEditorContent = false
	): Promise<{ file: TFile | null; content: string }> {
		const currentFile = this.app.workspace.getActiveFile();

		// If no file is open, return empty content
		if (!currentFile) {
			return { file: null, content: "" };
		}

		// For editor view, get content directly from editor if requested
		if (useEditorContent && !this.isReadingView) {
			const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (mdView?.editor && mdView.file === currentFile) {
				return {
					file: currentFile,
					content: mdView.editor.getValue(),
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
			if (
				this.lastFilePath === currentFile.path &&
				this.lastFileContent
			) {
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
			const leaves =
				this.app.workspace.getLeavesOfType(VIEW_TYPE_PROGRESS_BAR);
			if (leaves.length === 0) {
				return;
			}

			// Get file content and count tasks
			const { file, content } = await this.getFileContent(
				useEditorContent
			);
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
			this.lastFilePath = file.path;

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
		if (this.updateTimer) {
			clearTimeout(this.updateTimer);
		}

		console.log("Unloading Progress Bar Sidebar plugin");
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_PROGRESS_BAR);
	}

	async activateView() {
		const { workspace } = this.app;

		// Check if view already exists
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_PROGRESS_BAR);
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
			type: VIEW_TYPE_PROGRESS_BAR,
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

	private initLeaf() {
		this.activateView();
	}
}

// Simple view class for displaying progress
class ProgressBarView extends View {
	plugin: ProgressBarPlugin;
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

			// Apply dynamic styles based on settings
			this.applyDynamicStyles();

			// Create element to be updated later
			this.progressContainerEl =
				this.contentEl.createDiv("progress-container");

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

	// Apply dynamic styles that depend on settings
	private applyDynamicStyles() {
		// Create or update dynamic style element
		let styleEl = document.getElementById("progress-bar-dynamic-styles");
		if (!styleEl) {
			styleEl = document.createElement("style");
			styleEl.id = "progress-bar-dynamic-styles";
			document.head.appendChild(styleEl);
		}

		// Set dynamic styles based on settings
		styleEl.textContent = `
			.progress-bar-view .bar-container {
				height: ${this.plugin.settings.barHeight}px;
			}
			.progress-bar-view .bar {
				background-color: ${this.plugin.settings.barColor};
				height: ${this.plugin.settings.barHeight}px;
			}
		`;
	}

	async onClose(): Promise<void> {
		// Remove dynamic styles when view is closed
		const styleEl = document.getElementById("progress-bar-dynamic-styles");
		if (styleEl) {
			styleEl.remove();
		}
	}

	getViewType(): string {
		return VIEW_TYPE_PROGRESS_BAR;
	}

	getDisplayText(): string {
		return "Task Progress";
	}

	getIcon(): string {
		return "bar-chart-horizontal";
	}

	showNoFileMessage(): void {
		if (!this.progressContainerEl) return;

		this.progressContainerEl.empty();
		this.progressContainerEl.createEl("div", {
			text: "Open a file to view task progress",
			cls: "no-tasks-info",
		});
	}

	updateProgress(file: TFile, totalTasks: number, completedTasks: number) {
		// Ensure UI elements exist
		if (!this.progressContainerEl || !this.contentEl) {
			return;
		}

		try {
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
			const barContainer =
				this.progressContainerEl.createDiv("bar-container");
			const bar = barContainer.createDiv("bar");
			bar.style.width = `${percent}%`;

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
