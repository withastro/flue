import {
	DitheringShapes,
	DitheringTypes,
	ShaderFitOptions,
	ShaderMount,
	defaultPatternSizing,
	ditheringFragmentShader,
	getShaderColorFromString,
	type DitheringShape,
	type DitheringType,
} from "@paper-design/shaders";

type DitheringConfig = {
	colorBack: string;
	colorFront: string;
	shape: DitheringShape;
	type: DitheringType;
	size: number;
	scale: number;
	speed: number;
	frame?: number;
};

type AmbientState = {
	config: DitheringConfig;
	mount?: ShaderMount;
	visible: boolean;
};

type PerformanceNavigator = Navigator & {
	connection?: { saveData?: boolean };
	deviceMemory?: number;
};

export function setupHomepageShaders() {
	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
	const smallViewport = window.matchMedia("(max-width: 767px)");
	const performanceNavigator = navigator as PerformanceNavigator;
	const constrainedDevice =
		(performanceNavigator.hardwareConcurrency > 0 &&
			performanceNavigator.hardwareConcurrency <= 4) ||
		(performanceNavigator.deviceMemory !== undefined && performanceNavigator.deviceMemory <= 4) ||
		performanceNavigator.connection?.saveData === true;
	const shouldAnimate = () =>
		!reducedMotion.matches && !smallViewport.matches && !constrainedDevice;
	const pixelBudget = () => (smallViewport.matches || constrainedDevice ? 8000 : 70000);
	const makeDithering = (element: HTMLElement, config: DitheringConfig) => {
		try {
			return new ShaderMount(
				element,
				ditheringFragmentShader,
				{
					u_colorBack: getShaderColorFromString(config.colorBack),
					u_colorFront: getShaderColorFromString(config.colorFront),
					u_shape: DitheringShapes[config.shape],
					u_type: DitheringTypes[config.type],
					u_pxSize: config.size,
					u_fit: ShaderFitOptions[defaultPatternSizing.fit],
					u_scale: config.scale,
					u_rotation: defaultPatternSizing.rotation,
					u_offsetX: defaultPatternSizing.offsetX,
					u_offsetY: defaultPatternSizing.offsetY,
					u_originX: defaultPatternSizing.originX,
					u_originY: defaultPatternSizing.originY,
					u_worldWidth: defaultPatternSizing.worldWidth,
					u_worldHeight: defaultPatternSizing.worldHeight,
				},
				{ alpha: true, antialias: false },
				0,
				config.frame ?? 0,
				1,
				pixelBudget(),
			);
		} catch {
			element.querySelector("canvas")?.remove();
			return undefined;
		}
	};

	const ambientStates = new Map<HTMLElement, AmbientState>();
	document.querySelectorAll<HTMLElement>("[data-ambient-shader]").forEach((element) => {
		ambientStates.set(element, {
			config: {
				colorBack: element.dataset.colorBack!,
				colorFront: element.dataset.colorFront!,
				shape: element.dataset.shape! as DitheringShape,
				type: element.dataset.type! as DitheringType,
				size: Number(element.dataset.size),
				scale: Number(element.dataset.scale),
				speed: Number(element.dataset.speed),
				frame: element.dataset.frame ? Number(element.dataset.frame) : 0,
			},
			visible: false,
		});
	});

	const updateState = (state: AmbientState) => {
		if (!state.mount) return;
		state.mount.setMaxPixelCount(pixelBudget());
		state.mount.setSpeed(state.visible && shouldAnimate() ? state.config.speed : 0);
	};
	const mountState = (element: HTMLElement, state: AmbientState) => {
		if (state.mount) return;
		state.mount = makeDithering(element, state.config);
		updateState(state);
	};
	const disposeState = (state: AmbientState) => {
		state.mount?.dispose();
		state.mount = undefined;
	};

	const mountObserver = new IntersectionObserver(
		(entries) => {
			entries.forEach((entry) => {
				const element = entry.target as HTMLElement;
				const state = ambientStates.get(element);
				if (!state) return;
				if (entry.isIntersecting) {
					mountState(element, state);
				} else {
					disposeState(state);
				}
			});
		},
		{ rootMargin: "480px 0px" },
	);
	const motionObserver = new IntersectionObserver((entries) => {
		entries.forEach((entry) => {
			const state = ambientStates.get(entry.target as HTMLElement);
			if (!state) return;
			state.visible = entry.isIntersecting;
			updateState(state);
		});
	});
	ambientStates.forEach((_, element) => {
		mountObserver.observe(element);
		motionObserver.observe(element);
	});

	const updateMode = () => ambientStates.forEach((state) => updateState(state));
	reducedMotion.addEventListener("change", updateMode);
	smallViewport.addEventListener("change", updateMode);

	window.addEventListener(
		"pagehide",
		() => {
			mountObserver.disconnect();
			motionObserver.disconnect();
			reducedMotion.removeEventListener("change", updateMode);
			smallViewport.removeEventListener("change", updateMode);
			ambientStates.forEach((state) => disposeState(state));
		},
		{ once: true },
	);
}
