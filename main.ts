import {
	Plugin,
	WorkspaceLeaf,
	View,
	TFile,
	Notice,
	MarkdownView,
	App,
} from "obsidian";

// Commented out unused cache variables until implemented
// const progressCache = new Map<string, { timestamp: number; value: number }>();
// const CACHE_VALIDITY_MS = 2000; // 2 giây

function debounce<T extends (...args: any[]) => any>(
	func: T,
	wait: number
): (...args: Parameters<T>) => void {
	let timeout: NodeJS.Timeout;

	return function executedFunction(...args: Parameters<T>) {
		const later = () => {
			clearTimeout(timeout);
			func(...args);
		};

		clearTimeout(timeout);
		timeout = setTimeout(later, wait);
	};
}

export default class ProgressBarPlugin extends Plugin {
	settings: {
		barHeight?: number;
		barColor?: string;
		showTaskCount?: boolean;
	} = {};

	// Add a MutationObserver to watch for checkbox changes
	private mutationObserver: MutationObserver | null = null;

	// Add a property to track the last clicked checkbox
	private lastClickedCheckbox: HTMLElement | null = null;

	// Add a property to track if an update is already in progress
	private updateInProgress = false;
	// Add timestamp to prevent updates too close together
	private lastUpdateTime = 0;

	// Add a property to track reading view updates separately
	private readingViewUpdateInProgress = false;
	private lastReadingViewUpdate = 0;

	// Thêm biến để theo dõi sự kiện cuộn
	private isScrolling = false;
	private scrollTimeout: NodeJS.Timeout | null = null;
	private lastTaskUpdate = 0;

	// Thêm biến để theo dõi checkbox đã thay đổi gần đây
	private recentlyChangedTasks: Map<string, number> = new Map(); // key: filePath + taskContent, value: timestamp
	private readingViewUpdateRetryCount = 0;
	private maxRetryCount = 5;
	private fileOperationInProgress = false;

	async onload() {
		console.log("Loading Progress Bar Sidebar plugin");

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

		// Add command
		this.addCommand({
			id: "show-task-progress-bar",
			name: "Show Task Progress Bar",
			callback: async () => {
				await this.activateView();
			},
		});

		// Activate view when layout is ready
		this.app.workspace.onLayoutReady(() => {
			this.activateView();
			this.setupObservers();
		});

		// Register essential events with unified handler
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () =>
				this.updateProgressBar()
			)
		);

		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				this.updateProgressBar();
				this.setupObservers();
			})
		);

		this.registerEvent(
			this.app.workspace.on("editor-change", () =>
				this.updateProgressBar()
			)
		);

		// Unified click handler for all checkbox interactions
		this.registerDomEvent(
			document,
			"click",
			this.handleCheckboxClick.bind(this)
		);

		// Listen for metadata changes
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile && activeFile.path === file.path) {
					this.updateProgressBar();
				}
			})
		);

		// Register for layout changes
		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.setupObservers())
		);

		// Handle keyboard interactions for reading view
		this.registerDomEvent(
			document,
			"keydown",
			this.handleKeyDown.bind(this)
		);

		// Thêm event listener cho sự kiện scroll để tránh cập nhật không cần thiết
		this.registerDomEvent(
			document,
			"scroll",
			this.handleScroll.bind(this),
			{ passive: true }
		);
	}

	// Xử lý sự kiện scroll để tránh cập nhật không cần thiết
	private handleScroll() {
		this.isScrolling = true;

		// Xóa timeout hiện tại nếu có
		if (this.scrollTimeout) {
			clearTimeout(this.scrollTimeout);
		}

		// Đặt timeout mới để đánh dấu khi scroll kết thúc
		this.scrollTimeout = setTimeout(() => {
			this.isScrolling = false;
			this.scrollTimeout = null;
		}, 150);
	}

	private handleCheckboxClick(evt: MouseEvent) {
		const target = evt.target as HTMLElement;

		// Improved checkbox detection
		const isCheckbox =
			target.matches(".task-list-item-checkbox") ||
			target.matches('input[type="checkbox"]') ||
			target.classList.contains("checkbox-container");

		if (isCheckbox || target.closest("li.task-list-item")) {
			// Ghi lại thời gian cập nhật checkbox
			this.lastTaskUpdate = Date.now();

			// Lấy thông tin về task được click
			const taskItem = target.closest("li.task-list-item");
			if (taskItem) {
				const taskContent = taskItem.textContent?.trim() || "";
				const currentFile = this.app.workspace.getActiveFile();
				if (currentFile) {
					// Lưu task này vào danh sách các task vừa được thay đổi
					const taskKey = `${currentFile.path}:${taskContent}`;
					this.recentlyChangedTasks.set(taskKey, Date.now());

					// Xóa khỏi danh sách sau 10 giây
					setTimeout(() => {
						this.recentlyChangedTasks.delete(taskKey);
					}, 10000);
				}
			}

			// In reading view, use a longer delay to ensure file is updated
			const isReadingView = !!target.closest(".markdown-reading-view");

			if (isReadingView) {
				// Reset retry count và bắt đầu quy trình cập nhật
				this.readingViewUpdateRetryCount = 0;
				// Sử dụng thời gian delay dài hơn trước khi thử cập nhật lần đầu
				setTimeout(() => this.scheduleReadingViewUpdate(), 800);
			} else {
				setTimeout(() => this.updateProgressBar(true), 100);
			}
		}
	}

	// Phương thức mới để lên lịch cập nhật reading view với cơ chế thử lại
	private scheduleReadingViewUpdate() {
		// Nếu đã thử quá nhiều lần, dừng lại
		if (this.readingViewUpdateRetryCount >= this.maxRetryCount) {
			console.log("Đã thử cập nhật quá nhiều lần, dừng thử lại");
			this.readingViewUpdateRetryCount = 0;
			return;
		}

		// Tăng số lần thử
		this.readingViewUpdateRetryCount++;

		// Thực hiện cập nhật
		this.updateProgressBarForReadingView().then((success) => {
			if (
				!success &&
				this.readingViewUpdateRetryCount < this.maxRetryCount
			) {
				// Nếu không thành công và chưa đạt số lần thử tối đa, thử lại
				console.log(
					`Thử lại cập nhật reading view lần ${this.readingViewUpdateRetryCount}`
				);
				// Tăng thời gian chờ giữa các lần thử
				const delay = 500 + this.readingViewUpdateRetryCount * 200;
				setTimeout(() => this.scheduleReadingViewUpdate(), delay);
			} else if (success) {
				// Nếu thành công, reset số lần thử
				this.readingViewUpdateRetryCount = 0;
			}
		});
	}

	private handleKeyDown(evt: KeyboardEvent) {
		if (evt.code === "Space") {
			const activeElement = document.activeElement;
			const isInReadingView = !!activeElement?.closest(
				".markdown-reading-view"
			);

			if (
				activeElement &&
				(activeElement.matches('input[type="checkbox"]') ||
					activeElement.closest(".task-list-item")) &&
				isInReadingView
			) {
				// Ghi lại thời gian cập nhật checkbox
				this.lastTaskUpdate = Date.now();

				// Lấy thông tin về task được thay đổi
				const taskItem = activeElement.closest("li.task-list-item");
				if (taskItem) {
					const taskContent = taskItem.textContent?.trim() || "";
					const currentFile = this.app.workspace.getActiveFile();
					if (currentFile) {
						// Lưu task này vào danh sách các task vừa được thay đổi
						const taskKey = `${currentFile.path}:${taskContent}`;
						this.recentlyChangedTasks.set(taskKey, Date.now());

						// Xóa khỏi danh sách sau 10 giây
						setTimeout(() => {
							this.recentlyChangedTasks.delete(taskKey);
						}, 10000);
					}
				}

				// Reset retry count và bắt đầu quy trình cập nhật
				this.readingViewUpdateRetryCount = 0;
				setTimeout(() => this.scheduleReadingViewUpdate(), 800);
			}
		}
	}

	// New method specifically for reading view updates
	private async updateProgressBarForReadingView(): Promise<boolean> {
		// Không cập nhật nếu đang cuộn trang
		if (this.isScrolling) {
			return false;
		}

		// Tránh cập nhật trùng lặp
		if (this.readingViewUpdateInProgress) {
			return false;
		}

		const currentFile = this.app.workspace.getActiveFile();
		if (!currentFile) return false;

		// Đánh dấu đang cập nhật
		this.readingViewUpdateInProgress = true;
		this.fileOperationInProgress = true;

		try {
			// Chờ một khoảng thời gian ngắn để đảm bảo file đã được lưu
			await new Promise((resolve) => setTimeout(resolve, 200));

			// Đảm bảo đọc từ file gốc để lấy trạng thái mới nhất
			const content = await this.app.vault.read(currentFile);

			// Sử dụng phương pháp đếm task đã cải tiến
			const { total, completed } = this.countTasks(content);

			// Kiểm tra xem kết quả có hợp lý không dựa trên các thay đổi gần đây
			// Nếu có task mới được thay đổi nhưng kết quả không phản ánh điều đó, có thể file chưa được cập nhật
			const taskChangesNotReflected = this.checkRecentTaskChanges(
				currentFile.path,
				content
			);
			if (taskChangesNotReflected) {
				console.log(
					"Phát hiện thay đổi task chưa được ghi vào file, thử lại sau"
				);
				return false;
			}

			console.log(
				`Reading view task count (after verify): ${completed}/${total}`
			);

			// Cập nhật tất cả các view progress bar
			const leaves =
				this.app.workspace.getLeavesOfType("progress-bar-view");
			for (const leaf of leaves) {
				const view = leaf.view;
				if (view instanceof ProgressBarView) {
					view.updateProgress(currentFile, total, completed);
				}
			}

			return true;
		} catch (error) {
			console.error(
				"Lỗi cập nhật từ nội dung file trong reading view:",
				error
			);
			return false;
		} finally {
			// Giải phóng lock
			this.fileOperationInProgress = false;
			// Trì hoãn việc đặt lại readingViewUpdateInProgress để tránh cập nhật quá nhanh
			setTimeout(() => {
				this.readingViewUpdateInProgress = false;
			}, 500);
		}
	}

	// Phương thức mới để kiểm tra xem các thay đổi task gần đây đã được phản ánh trong nội dung hay chưa
	private checkRecentTaskChanges(
		filePath: string,
		fileContent: string
	): boolean {
		// Nếu không có task nào được thay đổi gần đây, không cần kiểm tra
		if (this.recentlyChangedTasks.size === 0) {
			return false;
		}

		// Kiểm tra từng task đã được thay đổi
		let changeDetected = false;
		for (const [
			taskKey,
			timestamp,
		] of this.recentlyChangedTasks.entries()) {
			// Nếu đã quá 10 giây, bỏ qua task này
			if (Date.now() - timestamp > 10000) {
				this.recentlyChangedTasks.delete(taskKey);
				continue;
			}

			// Kiểm tra xem task key có thuộc file này không
			if (taskKey.startsWith(`${filePath}:`)) {
				// Phần taskContent trong taskKey (loại bỏ filePath:)
				const taskContent = taskKey.substring(filePath.length + 1);

				// Tìm trong nội dung file
				// Ở đây chúng ta chỉ đơn giản kiểm tra xem nội dung có chứa task này không
				// Một cách chính xác hơn sẽ là phân tích cú pháp task, nhưng điều này đủ để phát hiện
				// nếu file chưa được cập nhật
				if (!fileContent.includes(taskContent)) {
					changeDetected = true;
				}
			}
		}

		return changeDetected;
	}

	// Combined method to setup all observers
	private setupObservers() {
		// Clean up any existing observers
		if (this.mutationObserver) {
			this.mutationObserver.disconnect();
			this.mutationObserver = null;
		}

		// Single combined observer setup
		const observer = new MutationObserver((mutations) => {
			// Không xử lý sự kiện nếu đang cuộn trang hoặc có file operation đang diễn ra
			if (this.isScrolling || this.fileOperationInProgress) {
				return;
			}

			// Phát hiện xem là reading view hay không
			const isReadingView = !!mutations[0]?.target?.closest(
				".markdown-reading-view"
			);

			// Lọc các mutation liên quan đến task
			const hasTaskChanges = mutations.some((mutation) =>
				this.isTaskRelatedMutation(mutation)
			);

			if (hasTaskChanges) {
				// Đối với reading view, sử dụng phương thức chuyên biệt
				if (isReadingView) {
					// Tránh cập nhật nếu không có sự kiện người dùng gần đây
					const timeSinceLastUpdate =
						Date.now() - this.lastTaskUpdate;
					if (timeSinceLastUpdate < 2000) {
						// Reset retry count và bắt đầu quy trình cập nhật
						this.readingViewUpdateRetryCount = 0;
						setTimeout(() => this.scheduleReadingViewUpdate(), 800);
					}
				} else {
					// Cập nhật bình thường cho chế độ khác
					this.updateProgressBar();
				}
			}
		});

		// Set up observation for both reading view and preview view
		const targets = [
			...Array.from(document.querySelectorAll(".markdown-reading-view")),
			...Array.from(document.querySelectorAll(".markdown-preview-view")),
		];

		if (targets.length > 0) {
			targets.forEach((target) => {
				observer.observe(target, {
					attributes: true,
					attributeFilter: ["checked", "class", "data-task"],
					childList: true,
					subtree: true,
					characterData: true,
				});
			});

			this.mutationObserver = observer;
		}
	}

	// Helper to check if a mutation is task-related
	private isTaskRelatedMutation(mutation: MutationRecord): boolean {
		// For attribute changes
		if (mutation.type === "attributes") {
			const target = mutation.target as HTMLElement;

			// Kiểm tra kỹ hơn cho task
			if (target.matches('input[type="checkbox"]')) return true;
			if (target.classList.contains("task-list-item")) return true;
			if (target.classList.contains("task-list-item-checkbox"))
				return true;

			// Kiểm tra thuộc tính cụ thể
			if (
				mutation.attributeName === "checked" ||
				(mutation.attributeName === "class" &&
					target.classList.contains("is-checked"))
			) {
				return true;
			}

			return false;
		}

		// For DOM structure changes
		if (mutation.type === "childList") {
			// Check added nodes
			const addedTaskNodes = Array.from(mutation.addedNodes).some(
				isTaskElement
			);
			if (addedTaskNodes) return true;

			// Check removed nodes
			const removedTaskNodes = Array.from(mutation.removedNodes).some(
				isTaskElement
			);
			if (removedTaskNodes) return true;

			// Kiểm tra parent node xem có phải là task-related không
			const parent = mutation.target as HTMLElement;
			if (
				parent.matches(".task-list-item") ||
				parent.closest(".task-list-item") ||
				parent.closest(".contains-task-list")
			) {
				return true;
			}
		}

		return false;
	}

	async onunload() {
		// Clean up mutation observer
		if (this.mutationObserver) {
			this.mutationObserver.disconnect();
			this.mutationObserver = null;
		}

		console.log("Unloading Progress Bar Sidebar plugin");
		this.app.workspace.detachLeavesOfType("progress-bar-view");
	}

	async activateView() {
		const { workspace } = this.app;

		// Kiểm tra xem view đã tồn tại chưa
		const leaves = workspace.getLeavesOfType("progress-bar-view");
		if (leaves.length > 0) {
			workspace.revealLeaf(leaves[0]);
			return;
		}

		// Tạo leaf mới ở sidebar bên phải
		let leaf = workspace.getRightLeaf(false);
		if (!leaf) {
			if (!workspace.rightSplit) {
				new Notice("Vui lòng mở sidebar bên phải trước");
				return;
			}
			leaf = workspace.getLeaf("split", "vertical");
			if (workspace.rightSplit) {
				leaf.parent = workspace.rightSplit;
			}
		}

		// Thiết lập view
		await leaf.setViewState({
			type: "progress-bar-view",
			active: true,
		});

		// Hiển thị leaf
		workspace.revealLeaf(leaf);

		// Cập nhật progress bar
		this.updateProgressBar();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{
				barHeight: 12,
				barColor: "#738bd7", // Màu mặc định đẹp hơn
				showTaskCount: true,
			},
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// Enhanced task counting to handle different task formats
	countTasks(content: string): { total: number; completed: number } {
		// Sử dụng biểu thức chính quy tốt hơn phù hợp với định dạng công việc của Obsidian
		const taskLineRegex = /^\s*[-*+] \[([ xX#\-\/>])\](?!\()/gm;

		try {
			const matches = [...content.matchAll(taskLineRegex)];

			const total = matches.length;
			let completed = 0;

			for (const match of matches) {
				// Lấy ký tự bên trong dấu ngoặc
				const checkChar = match[1];
				// Coi là hoàn thành nếu không phải dấu cách
				if (checkChar !== " ") {
					completed++;
				}
			}

			return { total, completed };
		} catch (e) {
			console.error("Lỗi khi đếm task:", e);
			return { total: 0, completed: 0 };
		}
	}

	// Phương thức cập nhật hợp nhất có thể được ép buộc hoặc debounced
	updateProgressBar = debounce(async (force = false) => {
		// Ngăn các bản cập nhật trùng lặp quá gần nhau
		const now = Date.now();
		if (!force && now - this.lastUpdateTime < 300) {
			return;
		}

		// Không chạy cập nhật nếu một cập nhật đã đang diễn ra
		if (this.updateInProgress) {
			return;
		}

		this.updateInProgress = true;
		this.lastUpdateTime = now;

		try {
			const { workspace, vault } = this.app;
			const currentFile = workspace.getActiveFile();
			if (!currentFile) {
				return;
			}

			// Lấy các leaf
			const leaves = workspace.getLeavesOfType("progress-bar-view");
			if (leaves.length === 0) {
				return;
			}

			// Lấy nội dung với phát hiện nguồn thích hợp
			const content = await this.getFileContent(currentFile);

			// Đếm công việc trong nội dung
			const { total, completed } = this.countTasks(content);

			// Cập nhật tất cả các view thanh tiến trình
			for (const leaf of leaves) {
				const view = leaf.view;
				if (view instanceof ProgressBarView) {
					view.updateProgress(currentFile, total, completed);
				}
			}
		} catch (error) {
			console.error("Lỗi khi cập nhật thanh tiến trình:", error);
		} finally {
			this.updateInProgress = false;
		}
	}, 50);

	// Phương thức trợ giúp để lấy nội dung tệp từ nguồn thích hợp
	private async getFileContent(file: TFile): Promise<string> {
		const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
		const isReadingView =
			document.querySelector(".markdown-reading-view") !== null;

		try {
			// Trong chế độ chỉnh sửa, lấy trực tiếp từ editor
			if (mdView?.editor) {
				return mdView.editor.getValue();
			}
			// Trong chế độ đọc, luôn đọc trực tiếp từ file (không dùng cache)
			else if (isReadingView) {
				// Đảm bảo đọc file mới nhất
				return await this.app.vault.read(file);
			}
			// Các chế độ khác
			else {
				return await this.app.vault.read(file);
			}
		} catch (e) {
			console.warn("Không thể đọc tệp:", e);
			// Fallback to cached read
			return await this.app.vault.cachedRead(file);
		}
	}

	// Create a debounced version of updateProgressBarForReadingView to prevent duplicates
	private debouncedReadingViewUpdate = debounce(() => {
		// Prevent multiple reading view updates too close together
		const now = Date.now();
		if (
			now - this.lastReadingViewUpdate < 300 ||
			this.readingViewUpdateInProgress
		) {
			return;
		}

		this.readingViewUpdateInProgress = true;
		this.lastReadingViewUpdate = now;

		this.updateProgressBarForReadingView().finally(() => {
			this.readingViewUpdateInProgress = false;
		});
	}, 100);
}

// Helper function to check if a node is task-related
function isTaskElement(node: Node): boolean {
	if (node.nodeType !== Node.ELEMENT_NODE) return false;
	const el = node as HTMLElement;

	return (
		el.matches(".task-list-item") ||
		el.matches('input[type="checkbox"]') ||
		el.classList.contains("task-list-item-checkbox") ||
		el.classList.contains("contains-task-list") ||
		!!el.querySelector(
			'.task-list-item, input[type="checkbox"], .task-list-item-checkbox'
		)
	);
}

class ProgressBarView extends View {
	plugin: ProgressBarPlugin;
	app: App; // Kiểu đúng thay vì any
	private viewReady = false;
	private fileNameEl: HTMLElement | null = null;
	private progressContainerEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: ProgressBarPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.app = plugin.app;
	}

	async onOpen(): Promise<void> {
		try {
			// Đảm bảo containerEl tồn tại
			if (!this.containerEl) {
				console.error("Lỗi: containerEl không tồn tại");
				return;
			}

			// Đảm bảo contentEl tồn tại
			if (!this.contentEl) {
				console.log("Khởi tạo contentEl mới vì nó chưa tồn tại");
				this.contentEl = this.containerEl.createDiv("view-content");
			}

			// Bây giờ mới an toàn để truy cập contentEl
			this.contentEl.empty();
			this.contentEl.addClass("progress-bar-view");

			// Tạo các phần tử cố định không thay đổi giữa các lần cập nhật
			this.contentEl.createEl("h4", {
				text: "Task Progress",
				cls: "progress-bar-title",
			});

			// Tạo các phần tử sẽ được cập nhật sau
			this.fileNameEl = this.contentEl.createDiv("file-info");
			this.progressContainerEl =
				this.contentEl.createDiv("progress-container");

			// Trạng thái ban đầu khi không có tệp nào được mở
			this.showNoFileMessage();

			// Đặt view là sẵn sàng và yêu cầu cập nhật ban đầu
			this.viewReady = true;
			setTimeout(() => {
				try {
					const currentFile = this.app.workspace.getActiveFile();
					if (currentFile) {
						this.plugin.updateProgressBar();
					}
				} catch (err) {
					console.error(
						"Lỗi khi cập nhật progressBar trong onOpen:",
						err
					);
				}
			}, 300);
		} catch (error) {
			console.error("Lỗi trong onOpen:", error);
			// Cố gắng hiển thị lỗi nếu có thể
			if (this.containerEl) {
				const errorDiv = this.containerEl.createDiv("error");
				errorDiv.setText(`Lỗi: ${error.message || "Không xác định"}`);
			}
		}
	}

	private showNoFileMessage(): void {
		if (!this.fileNameEl || !this.progressContainerEl) return;

		this.fileNameEl.empty();
		this.fileNameEl.createEl("div", {
			text: "Không có tệp nào mở",
			cls: "file-name",
		});

		this.progressContainerEl.empty();
		this.progressContainerEl.createEl("div", {
			text: "Mở một tệp để xem tiến trình công việc",
			cls: "no-file-info",
		});
	}

	onClose() {
		this.viewReady = false;
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

	updateProgress(file: TFile, totalTasks: number, completedTasks: number) {
		// Thêm các kiểm tra bổ sung
		if (!this.viewReady) {
			console.log("View chưa sẵn sàng, bỏ qua cập nhật");
			return;
		}

		// Đảm bảo contentEl tồn tại và được kết nối với DOM
		if (!this.contentEl || !this.contentEl.isConnected) {
			console.log(
				"contentEl không tồn tại hoặc không được kết nối, bỏ qua cập nhật"
			);
			return;
		}

		// Đảm bảo các phần tử UI đã được tạo
		if (!this.fileNameEl || !this.progressContainerEl) {
			console.log("Các phần tử UI chưa được khởi tạo, thử tạo lại");
			try {
				// Thử tạo lại các phần tử UI
				this.fileNameEl =
					this.fileNameEl || this.contentEl.createDiv("file-info");
				this.progressContainerEl =
					this.progressContainerEl ||
					this.contentEl.createDiv("progress-container");
			} catch (e) {
				console.error("Không thể tạo lại các phần tử UI:", e);
				return;
			}
		}

		try {
			// Cập nhật tên tệp
			if (this.fileNameEl) {
				this.fileNameEl.empty();
				this.fileNameEl.createEl("div", {
					text: file.name,
					cls: "file-name",
				});
			}

			// Cập nhật container tiến trình
			if (this.progressContainerEl) {
				this.progressContainerEl.empty();

				if (totalTasks === 0) {
					this.progressContainerEl.createEl("div", {
						text: "Không tìm thấy công việc nào trong tệp này",
						cls: "no-tasks-info",
					});
					return;
				}

				const percent = Math.round((completedTasks / totalTasks) * 100);

				// Tạo thanh tiến trình
				const barContainer =
					this.progressContainerEl.createDiv("bar-container");
				const bar = barContainer.createDiv("bar");
				bar.style.width = `${percent}%`;

				// Áp dụng cài đặt
				if (this.plugin.settings?.barColor) {
					bar.style.backgroundColor = this.plugin.settings.barColor;
				}

				if (this.plugin.settings?.barHeight) {
					barContainer.style.height = `${this.plugin.settings.barHeight}px`;
					bar.style.height = `${this.plugin.settings.barHeight}px`;
				}

				// Thêm nhãn phần trăm
				this.progressContainerEl.createEl("div", {
					text: `${percent}% hoàn thành`,
					cls: "progress-label",
				});

				// Thêm số lượng công việc nếu được bật trong cài đặt
				if (this.plugin.settings?.showTaskCount !== false) {
					this.progressContainerEl.createEl("div", {
						text: `${completedTasks} trên ${totalTasks} công việc đã hoàn thành`,
						cls: "task-count-info",
					});
				}
			}
		} catch (error) {
			console.error("Lỗi cập nhật thanh tiến trình:", error);
			this.displayError(error);
		}
	}

	private displayError(error: any) {
		try {
			// Đảm bảo contentEl tồn tại trước khi sử dụng
			if (!this.contentEl) {
				console.error(
					"Không thể hiển thị lỗi vì contentEl không tồn tại"
				);
				return;
			}

			this.contentEl.empty();
			this.contentEl.createEl("h4", { text: "Task Progress" });
			this.contentEl.createEl("div", {
				text: `Lỗi: ${error?.message || "Lỗi không xác định"}`,
				cls: "error-message",
			});
		} catch (displayError) {
			console.error("Lỗi hiển thị thông báo lỗi:", displayError);
		}
	}
}
