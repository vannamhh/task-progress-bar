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
const READING_VIEW_UPDATE_DELAY = 200; // Reduced from 500ms to 200ms for faster reading view updates

// View type constant
const VIEW_TYPE_PROGRESS_BAR = "progress-bar-view";

interface ProgressBarSettings {
	barColor: string;
	barHeight: number;
	showTaskCount: boolean;
	debounceTime?: number;
	readingViewDelay?: number;
	useColorStates: boolean; // Add option to use color states
	lowProgressColor: string; // Red for low progress
	mediumProgressColor: string; // Orange for medium progress
	highProgressColor: string; // Green for high progress
}

const DEFAULT_SETTINGS: ProgressBarSettings = {
	barColor: "#5e81ac",
	barHeight: 20,
	showTaskCount: true,
	debounceTime: 300,
	readingViewDelay: 200, // Reduced from 500ms to 200ms for faster updates
	useColorStates: false, // Disabled by default to maintain backward compatibility
	lowProgressColor: "#e06c75", // Red
	mediumProgressColor: "#e5c07b", // Orange/Yellow
	highProgressColor: "#98c379", // Green
};

// Task counting regex - defined once for better performance
const TASK_LINE_REGEX = /^\s*[-*+] \[([ xX#\->/])\](?!\()/gm;

export default class ProgressBarPlugin extends Plugin {
	settings: ProgressBarSettings;
	private view: ProgressBarView | null = null;
	private updateTimer: NodeJS.Timeout | null = null;
	private fileCache = new Map<
		string,
		{ content: string; timestamp: number }
	>();
	private isReadingView = false;

	private vault: Vault;
	private metadataCache: MetadataCache;

	// Debounced update handler
	private debouncedUpdate: (...args: any[]) => void;

	async onload(): Promise<void> {
		console.log("Loading Progress Bar Sidebar plugin");

		// Store references to vault and metadata cache for easier access
		this.vault = this.app.vault;
		this.metadataCache = this.app.metadataCache;

		await this.loadSettings();

		// Initialize the debounced update function after settings are loaded
		// Fix: Ensure we always have a number by using a more definitive approach
		const debounceTime =
			this.settings.debounceTime !== undefined &&
			typeof this.settings.debounceTime === "number"
				? this.settings.debounceTime
				: DEFAULT_SETTINGS.debounceTime;

		this.debouncedUpdate = this.debounce((useEditorContent = false) => {
			this.updateProgressBar(useEditorContent);
		}, debounceTime ?? 300);

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
			this.activateView.bind(this)
		);

		// Add command to show progress bar
		this.addCommand({
			id: "show-task-progress-bar",
			name: "Show Task Progress Bar",
			callback: this.activateView.bind(this),
		});

		// Add command to refresh progress bar
		this.addCommand({
			id: "refresh-task-progress-bar",
			name: "Refresh Task Progress Bar",
			callback: () => {
				new Notice("Refreshing progress bar...");
				this.scheduleUpdate(true);
			},
		});

		// Activate view when layout is ready
		this.app.workspace.onLayoutReady(this.initLeaf.bind(this));

		this.registerEventHandlers();

		// Add settings tab
		this.addSettingTab(new ProgressBarSettingTab(this.app, this));
	}

	// Separate event handlers for better organization
	private registerEventHandlers(): void {
		// Register for file changes
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file) {
					this.checkViewMode();
					this.scheduleUpdate();
				}
			})
		);

		// Register for editor changes - optimized with debounce
		this.registerEvent(
			this.app.workspace.on("editor-change", (editor, view) => {
				if (view?.file) {
					this.isReadingView = false;
					// Cache file content
					const content = editor.getValue();
					this.fileCache.set(view.file.path, {
						content,
						timestamp: Date.now(),
					});
					this.debouncedUpdate(true);
				}
			})
		);

		// Handle checkbox clicks
		this.registerDomEvent(
			document,
			"click",
			this.handleCheckboxClick.bind(this)
		);

		// Listen for metadata changes
		this.registerEvent(
			this.metadataCache.on("changed", (file) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile?.path === file.path) {
					// Clear cached content to force a fresh read
					this.fileCache.delete(file.path);
					this.scheduleUpdate();
				}
			})
		);

		// Listen for layout changes
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.checkViewMode();
				this.scheduleUpdate();
			})
		);
	}

	// Improved debounce implementation
	private debounce(
		callback: Function,
		wait: number
	): (...args: any[]) => void {
		let timeout: NodeJS.Timeout | null = null;
		return (...args: any[]) => {
			if (timeout) clearTimeout(timeout);
			timeout = setTimeout(() => {
				callback(...args);
			}, wait);
		};
	}

	// Dedicated handler for checkbox clicks
	private handleCheckboxClick(evt: MouseEvent): void {
		const target = evt.target as HTMLElement;
		const isCheckbox =
			target.matches(".task-list-item-checkbox") ||
			target.matches('input[type="checkbox"]');

		if (isCheckbox || target.closest("li.task-list-item")) {
			this.checkViewMode();
			this.scheduleUpdate(true);

			if (this.isReadingView) {
				// Use shorter timeouts for better responsiveness in reading view
				setTimeout(() => this.scheduleUpdate(true), 100); // Reduced from 300ms to 100ms
				setTimeout(() => this.scheduleUpdate(true), 400); // Reduced from 800ms to 400ms
			}
		}
	}

	// Load CSS styles
	loadStyles(): void {
		const styleEl = document.createElement("style");
		styleEl.id = "progress-bar-sidebar-styles";

		styleEl.textContent = `
            /* Progress Bar Sidebar Plugin Styles */
            .progress-bar-view {
                padding: 10px !important;
                height: 120px !important;
                overflow: hidden !important;
            }
            
            .progress-bar-view .bar-container {
                background-color: var(--background-secondary);
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

		document.head.appendChild(styleEl);
		this.register(() => styleEl.remove());
	}

	// Check if we're in reading view or editing view
	private checkViewMode(): void {
		const isReading =
			document.querySelector(".markdown-reading-view") !== null;
		if (isReading !== this.isReadingView) {
			this.isReadingView = isReading;
			// Clear file cache when switching modes
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile) {
				this.fileCache.delete(activeFile.path);
			}
		}
	}

	// Improved update scheduler
	scheduleUpdate(forceSync = false, useEditorContent = false): void {
		// Clear any existing timeout
		if (this.updateTimer) {
			clearTimeout(this.updateTimer);
		}

		// Determine appropriate delay based on context
		let delay = NORMAL_UPDATE_DELAY;

		if (forceSync) {
			delay = this.isReadingView ? 100 : TASK_UPDATE_DELAY; // Use much shorter delay for reading view
		} else if (this.isReadingView && !useEditorContent) {
			delay = this.settings.readingViewDelay || READING_VIEW_UPDATE_DELAY;
		}

		// Set a new timeout with appropriate delay
		this.updateTimer = setTimeout(() => {
			this.updateProgressBar(useEditorContent);
		}, delay);
	}

	// Optimized task counting function
	countTasks(content: string): { total: number; completed: number } {
		if (!content) {
			return { total: 0, completed: 0 };
		}

		try {
			// Reset regex lastIndex to ensure it starts from beginning
			TASK_LINE_REGEX.lastIndex = 0;

			const matches = Array.from(content.matchAll(TASK_LINE_REGEX));
			const total = matches.length;
			const completed = matches.filter(
				(match) => match[1] !== " "
			).length;

			return { total, completed };
		} catch (e) {
			console.error("Error counting tasks:", e);
			return { total: 0, completed: 0 };
		}
	}

	// Improved file content retrieval with caching
	private async getFileContent(
		useEditorContent = false
	): Promise<{ file: TFile | null; content: string }> {
		const currentFile = this.app.workspace.getActiveFile();

		// If no file is open, return empty content
		if (!currentFile) {
			return { file: null, content: "" };
		}

		const filePath = currentFile.path;
		const cachedData = this.fileCache.get(filePath);
		const cacheMaxAge = 2000; // 2 seconds cache validity

		// Use cached content if it's recent enough
		if (
			cachedData &&
			Date.now() - cachedData.timestamp < cacheMaxAge &&
			!this.isReadingView
		) {
			return { file: currentFile, content: cachedData.content };
		}

		// For editor view, get content directly from editor if requested
		if (useEditorContent && !this.isReadingView) {
			const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (mdView?.editor && mdView.file === currentFile) {
				const content = mdView.editor.getValue();
				// Update cache
				this.fileCache.set(filePath, {
					content,
					timestamp: Date.now(),
				});
				return { file: currentFile, content };
			}
		}

		try {
			// Read directly from vault for most accurate content
			const content = await this.vault.read(currentFile);
			// Update cache
			this.fileCache.set(filePath, { content, timestamp: Date.now() });
			return { file: currentFile, content };
		} catch (e) {
			console.warn("Error reading file:", e);

			// Fallback to cached content if available
			if (cachedData) {
				return { file: currentFile, content: cachedData.content };
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
	async updateProgressBar(useEditorContent = false): Promise<void> {
		try {
			// Get progress bar views
			const leaves = this.app.workspace.getLeavesOfType(
				VIEW_TYPE_PROGRESS_BAR
			);
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

	async onunload(): Promise<void> {
		// Clear any pending timeout
		if (this.updateTimer) {
			clearTimeout(this.updateTimer);
		}

		// Clear cache
		this.fileCache.clear();

		console.log("Unloading Progress Bar Sidebar plugin");
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_PROGRESS_BAR);
	}

	async activateView(): Promise<void> {
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

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Update dynamic styles when settings change
		if (this.view) {
			this.view.applyDynamicStyles();
		}
	}

	private initLeaf(): void {
		this.activateView();
	}
}

// Simple view class for displaying progress
class ProgressBarView extends View {
	plugin: ProgressBarPlugin;
	private progressContainerEl: HTMLElement | null = null;
	contentEl: HTMLElement;
	private dynamicStyleEl: HTMLStyleElement | null = null;

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
			this.displayError(error);
		}
	}

	// Apply dynamic styles that depend on settings
	applyDynamicStyles(): void {
		// Create or update dynamic style element
		if (!this.dynamicStyleEl) {
			this.dynamicStyleEl = document.createElement("style");
			this.dynamicStyleEl.id = "progress-bar-dynamic-styles";
			document.head.appendChild(this.dynamicStyleEl);
		}

		// Set dynamic styles based on settings
		this.dynamicStyleEl.textContent = `
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
		if (this.dynamicStyleEl) {
			this.dynamicStyleEl.remove();
			this.dynamicStyleEl = null;
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

	updateProgress(
		file: TFile,
		totalTasks: number,
		completedTasks: number
	): void {
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

			// Set color based on progress percentage if color states are enabled
			if (this.plugin.settings.useColorStates) {
				if (percent <= 33) {
					bar.style.backgroundColor =
						this.plugin.settings.lowProgressColor;
				} else if (percent <= 66) {
					bar.style.backgroundColor =
						this.plugin.settings.mediumProgressColor;
				} else {
					bar.style.backgroundColor =
						this.plugin.settings.highProgressColor;
				}
			} else {
				// Use default color from settings
				bar.style.backgroundColor = this.plugin.settings.barColor;
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

	private displayError(error: any): void {
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
	private colorStateSettings: Setting[] = [];

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
			.setDesc(
				"Set the color of the progress bar (when color states are disabled)"
			)
			.addText((text) =>
				text
					.setPlaceholder("#5e81ac")
					.setValue(this.plugin.settings.barColor || "")
					.onChange(async (value) => {
						this.plugin.settings.barColor = value;
						await this.plugin.saveSettings();
					})
			);

		// Color states toggle
		new Setting(containerEl)
			.setName("Use Color States")
			.setDesc("Change bar color based on progress percentage")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.useColorStates || false)
					.onChange(async (value) => {
						this.plugin.settings.useColorStates = value;
						// Show/hide color state settings based on toggle
						this.colorStateSettings.forEach((setting) => {
							setting.settingEl.toggle(value);
						});
						await this.plugin.saveSettings();
					})
			);

		// Color state settings
		const colorStateSettings: Setting[] = [];

		// Low progress color (Red)
		const lowProgressSetting = new Setting(containerEl)
			.setName("Low Progress Color")
			.setDesc("Color for 0-33% progress (default: red)")
			.addText((text) =>
				text
					.setPlaceholder("#e06c75")
					.setValue(
						this.plugin.settings.lowProgressColor ||
							DEFAULT_SETTINGS.lowProgressColor
					)
					.onChange(async (value) => {
						this.plugin.settings.lowProgressColor = value;
						await this.plugin.saveSettings();
					})
			);
		colorStateSettings.push(lowProgressSetting);

		// Medium progress color (Orange)
		const mediumProgressSetting = new Setting(containerEl)
			.setName("Medium Progress Color")
			.setDesc("Color for 34-66% progress (default: orange)")
			.addText((text) =>
				text
					.setPlaceholder("#e5c07b")
					.setValue(
						this.plugin.settings.mediumProgressColor ||
							DEFAULT_SETTINGS.mediumProgressColor
					)
					.onChange(async (value) => {
						this.plugin.settings.mediumProgressColor = value;
						await this.plugin.saveSettings();
					})
			);
		colorStateSettings.push(mediumProgressSetting);

		// High progress color (Green)
		const highProgressSetting = new Setting(containerEl)
			.setName("High Progress Color")
			.setDesc("Color for 67-100% progress (default: green)")
			.addText((text) =>
				text
					.setPlaceholder("#98c379")
					.setValue(
						this.plugin.settings.highProgressColor ||
							DEFAULT_SETTINGS.highProgressColor
					)
					.onChange(async (value) => {
						this.plugin.settings.highProgressColor = value;
						await this.plugin.saveSettings();
					})
			);
		colorStateSettings.push(highProgressSetting);

		// Save reference to settings for toggling visibility
		this.colorStateSettings = colorStateSettings;

		// Show/hide color state settings based on toggle state
		const showColorSettings = this.plugin.settings.useColorStates || false;
		colorStateSettings.forEach((setting) => {
			setting.settingEl.toggle(showColorSettings);
		});

		// ...existing code for bar height, show task count, etc...
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

		new Setting(containerEl)
			.setName("Update Delay")
			.setDesc("Set the delay (in ms) between updates when editing")
			.addText((text) =>
				text
					.setPlaceholder("300")
					.setValue(
						String(
							this.plugin.settings.debounceTime ||
								DEFAULT_SETTINGS.debounceTime
						)
					)
					.onChange(async (value) => {
						const numValue = parseInt(value);
						if (!isNaN(numValue) && numValue > 0) {
							this.plugin.settings.debounceTime = numValue;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Reading View Update Delay")
			.setDesc("Set the delay (in ms) between updates in reading view")
			.addText((text) =>
				text
					.setPlaceholder("200")
					.setValue(
						String(
							this.plugin.settings.readingViewDelay ||
								DEFAULT_SETTINGS.readingViewDelay
						)
					)
					.onChange(async (value) => {
						const numValue = parseInt(value);
						if (!isNaN(numValue) && numValue > 0) {
							this.plugin.settings.readingViewDelay = numValue;
							await this.plugin.saveSettings();
						}
					})
			);
	}
}
