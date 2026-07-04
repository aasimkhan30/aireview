export {
	InstantiationServiceBuilder,
	type IInstantiationServiceBuilder,
	type ServiceIdentifier,
	createServiceIdentifier
} from "./common/services";
export { SyncDescriptor } from "./vs/platform/instantiation/common/descriptors";
export {
	IInstantiationService,
	type BrandedService,
	type IInstantiationService as IInstantiationServiceShape,
	type ServicesAccessor,
	type ServiceIdentifier as InstantiationServiceIdentifier,
	createDecorator,
	refineServiceDecorator
} from "./vs/platform/instantiation/common/instantiation";
export { InstantiationService } from "./vs/platform/instantiation/common/instantiationService";
export { ServiceCollection } from "./vs/platform/instantiation/common/serviceCollection";
