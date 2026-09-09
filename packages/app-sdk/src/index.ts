import type { ComponentType } from "react";
import type {
  AppInstance,
  DefinitionId,
  Presentation,
  ResourceService,
  ResourceTarget,
  ResourceType,
  ThemePreference,
} from "../../contracts/src/index";
export interface HostServices {
  readonly resources: ResourceService;
  readonly navigation: {
    href(target: ResourceTarget, presentation: Presentation): string;
    open(target: ResourceTarget): void;
  };
  readonly theme: {
    preference: ThemePreference;
    setPreference(value: ThemePreference): void;
  };
}
export interface AppHostProps<D extends DefinitionId = DefinitionId> {
  readonly instance: AppInstance<D>;
  readonly presentation: Presentation;
  readonly services: HostServices;
}
/** P0 catalog previews have no instance or data services; they cannot pose as installations. */
export interface AppUIModule {
  readonly Root: ComponentType<AppHostProps>;
  readonly Preview: ComponentType;
}
export interface AppDefinition<D extends DefinitionId> {
  readonly id: D;
  readonly contractVersion: 1;
  readonly name: string;
  readonly description: string;
  readonly icon: "note" | "recipe";
  readonly resourceTypes: readonly ResourceType<D>[];
  readonly capabilities: readonly (
    "files" | "search" | "voice" | "deck" | "schedules"
  )[];
  readonly loadUI: () => Promise<AppUIModule>;
}
export type RegisteredDefinition = {
  [D in DefinitionId]: AppDefinition<D>;
}[DefinitionId];
