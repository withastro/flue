import {
	type DitheringShape,
	DitheringShapes,
	type DitheringType,
	DitheringTypes,
	defaultPatternSizing,
	ditheringFragmentShader,
	getShaderColorFromString,
	ShaderFitOptions,
	ShaderMount,
} from '@paper-design/shaders';

type DitheringConfig = {
	colorBack: string;
	colorFront: string;
	shape: DitheringShape;
	type: DitheringType;
	size: number;
	scale: number;
	speed: number;
};

type PerformanceNavigator = Navigator & {
	connection?: { saveData?: boolean };
	deviceMemory?: number;
};

export function setupDocsCoverShaders() {
	const element = document.querySelector<HTMLElement>('[data-docs-cover-shader]');
	if (!element || element.dataset.mounted === 'true') return;

	const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
	const smallViewport = window.matchMedia('(max-width: 767px)');
	const performanceNavigator = navigator as PerformanceNavigator;
	const constrainedDevice =
		(performanceNavigator.hardwareConcurrency > 0 &&
			performanceNavigator.hardwareConcurrency <= 4) ||
		(performanceNavigator.deviceMemory !== undefined && performanceNavigator.deviceMemory <= 4) ||
		performanceNavigator.connection?.saveData === true;
	const shouldAnimate = () => !reducedMotion.matches && !constrainedDevice;
	const pixelBudget = () => (smallViewport.matches || constrainedDevice ? 8000 : 70000);
	const { colorBack, colorFront, shape, type, size, scale, speed } = element.dataset;
	if (!colorBack || !colorFront || !shape || !type || !size || !scale || !speed) return;
	const config: DitheringConfig = {
		colorBack,
		colorFront,
		shape: shape as DitheringShape,
		type: type as DitheringType,
		size: Number(size),
		scale: Number(scale),
		speed: Number(speed),
	};
	let mount: ShaderMount | undefined;

	try {
		mount = new ShaderMount(
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
			0,
			1,
			pixelBudget(),
		);
	} catch {
		element.querySelector('canvas')?.remove();
		return;
	}

	element.dataset.mounted = 'true';
	const updateMode = () => {
		mount?.setMaxPixelCount(pixelBudget());
		mount?.setSpeed(shouldAnimate() ? config.speed : 0);
	};
	updateMode();
	reducedMotion.addEventListener('change', updateMode);
	smallViewport.addEventListener('change', updateMode);
	const dispose = (event: PageTransitionEvent) => {
		if (event.persisted) return;
		reducedMotion.removeEventListener('change', updateMode);
		smallViewport.removeEventListener('change', updateMode);
		mount?.dispose();
		window.removeEventListener('pagehide', dispose);
	};
	window.addEventListener('pagehide', dispose);
}
