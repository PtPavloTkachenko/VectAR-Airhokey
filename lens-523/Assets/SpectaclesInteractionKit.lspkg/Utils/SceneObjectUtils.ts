export const DEFAULT_MAX_PARENT_SEARCH_LEVELS: number = 16
export const DEFAULT_MAX_CHILD_SEARCH_LEVELS: number = 16

/**
 * Searches for a SceneObject with the given name in the tree rooted at the given root SceneObject.
 *
 * @param root - The root SceneObject of the tree to search.
 * @param name - The name of the SceneObject to search for.
 * @returns The first SceneObject with the given name if it exists in the tree, or undefined otherwise.
 */
export function findSceneObjectByName(root: SceneObject | null, name: string): SceneObject | null {
  if (root === null) {
    const rootObjectCount = global.scene.getRootObjectsCount()
    let current = 0
    while (current < rootObjectCount) {
      const result = findSceneObjectByName(global.scene.getRootObject(current), name)
      if (result) {
        return result
      }
      current += 1
    }
  } else {
    if (root.name === name) {
      return root
    }

    for (let i = 0; i < root.getChildrenCount(); i++) {
      const child = root.getChild(i)
      const result = findSceneObjectByName(child, name)
      if (result) {
        return result
      }
    }
  }
  return null
}

/**
 * Checks if a {@link SceneObject} is a descendant of another, treating self-as-descendant.
 *
 * NOTE: This differs from the native `SceneObject.isDescendantOf` LensCore API, which starts
 * its search from `this.parent` and therefore returns `false` when `sceneObject === root`.
 * This wrapper adds the `sceneObject === root` check to preserve legacy SIK behavior.
 *
 * @deprecated Prefer using `SceneObject.isDescendantOf` directly. If self-equality matters
 * at your call site, inline the check: `a === b || a.isDescendantOf(b)`.
 * @param sceneObject - the potential descendant.
 * @param root - the potential ascendant.
 * @returns true if sceneObject equals root or is a descendant of root, otherwise false.
 */
export function isDescendantOf(sceneObject: SceneObject, root: SceneObject): boolean {
  return sceneObject === root || sceneObject.isDescendantOf(root)
}

/**
 * [ByKey] Finds the first Component of a given type in the children of a SceneObject, searching recursively.
 * @deprecated Prefer `sceneObject.getComponentInDescendants(componentType, false, false, maxDepth)`.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The string key of the component type to find (e.g., "Component.RenderMeshVisual").
 * @param maxDepth - The maximum number of levels to search down the hierarchy.
 * @returns The first matching Component found, or null if none is found.
 */
export function findComponentInChildren<K extends keyof ComponentNameMap>(
  sceneObject: SceneObject,
  componentType: K,
  maxDepth?: number
): ComponentNameMap[K] | null

/**
 * [ByScriptType] Finds the first Component of a given script type in the children of a SceneObject, searching
 * recursively.
 * @deprecated Prefer `sceneObject.getComponentInDescendants(componentType, false, false, maxDepth)`.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The script type name (e.g., Interactable.getTypeName())) to find.
 * @param maxDepth - The maximum number of levels to search down the hierarchy.
 * @returns The first matching Component found, or null if none is found.
 */
export function findComponentInChildren<T extends BaseScriptComponent>(
  sceneObject: SceneObject,
  componentType: TypeName<T>,
  maxDepth?: number
): T | null

export function findComponentInChildren(
  sceneObject: SceneObject,
  componentType: keyof ComponentNameMap | TypeName<BaseScriptComponent>,
  maxDepth: number = DEFAULT_MAX_CHILD_SEARCH_LEVELS
): Component | null {
  return sceneObject.getComponentInDescendants(componentType as any, false, false, maxDepth)
}

/**
 * @deprecated Prefer `sceneObject.getComponentsInDescendants(componentType, false, false, maxDepth)`.
 * [ByKey] Finds all Components of a given type in the children of a SceneObject, searching recursively.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The string key of the component type to find (e.g., "Component.RenderMeshVisual").
 * @param maxDepth - The maximum number of levels to search down the hierarchy.
 * @returns An array of all matching Components found.
 */
export function findAllComponentsInChildren<K extends keyof ComponentNameMap>(
  sceneObject: SceneObject,
  componentType: K,
  maxDepth?: number
): ComponentNameMap[K][]

/**
 * @deprecated Prefer `sceneObject.getComponentsInDescendants(componentType, false, false, maxDepth)`.
 * [ByScriptType] Finds all Components of a given script type in the children of a SceneObject, searching recursively.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The script type name (e.g., Interactable.getTypeName())) to find.
 * @param maxDepth - The maximum number of levels to search down the hierarchy.
 * @returns An array of all matching Components found.
 */
export function findAllComponentsInChildren<T extends BaseScriptComponent>(
  sceneObject: SceneObject,
  componentType: TypeName<T>,
  maxDepth?: number
): T[]

export function findAllComponentsInChildren(
  sceneObject: SceneObject,
  componentType: keyof ComponentNameMap | TypeName<BaseScriptComponent>,
  maxDepth: number = DEFAULT_MAX_CHILD_SEARCH_LEVELS
): Component[] {
  return sceneObject.getComponentsInDescendants(componentType as any, false, false, maxDepth) as Component[]
}

/**
 * @deprecated Prefer `sceneObject.getComponentInDescendants(componentType, false, true, maxDepth)`.
 * [ByKey] Finds the first Component of a given type on the SceneObject itself or in its children.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The string key of the component type to find (e.g., "Component.RenderMeshVisual").
 * @param maxDepth - The maximum number of levels to search down the hierarchy (for children).
 * @returns The first matching Component found, or null if none is found.
 */
export function findComponentInSelfOrChildren<K extends keyof ComponentNameMap>(
  sceneObject: SceneObject,
  componentType: K,
  maxDepth?: number
): ComponentNameMap[K] | null

/**
 * @deprecated Prefer `sceneObject.getComponentInDescendants(componentType, false, true, maxDepth)`.
 * [ByScriptType] Finds the first Component of a given script type on the SceneObject itself or in its children.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The script type name (e.g., Interactable.getTypeName())) to find.
 * @param maxDepth - The maximum number of levels to search down the hierarchy (for children).
 * @returns The first matching Component found, or null if none is found.
 */
export function findComponentInSelfOrChildren<T extends BaseScriptComponent>(
  sceneObject: SceneObject,
  componentType: TypeName<T>,
  maxDepth?: number
): T | null

export function findComponentInSelfOrChildren(
  sceneObject: SceneObject,
  componentType: keyof ComponentNameMap | TypeName<BaseScriptComponent>,
  maxDepth: number = DEFAULT_MAX_CHILD_SEARCH_LEVELS
): Component | null {
  return sceneObject.getComponentInDescendants(componentType as any, false, true, maxDepth)
}

/**
 * @deprecated Prefer `sceneObject.getComponentsInDescendants(componentType, false, true, maxDepth)`.
 * [ByKey] Finds all Components of a given type on the SceneObject itself and in its children.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The string key of the component type to find (e.g., "Component.RenderMeshVisual").
 * @param maxDepth - The maximum number of levels to search down the hierarchy (for children).
 * @returns An array of all matching Components found.
 */
export function findAllComponentsInSelfOrChildren<K extends keyof ComponentNameMap>(
  sceneObject: SceneObject,
  componentType: K,
  maxDepth?: number
): ComponentNameMap[K][]

/**
 * @deprecated Prefer `sceneObject.getComponentsInDescendants(componentType, false, true, maxDepth)`.
 * [ByScriptType] Finds all Components of a given script type on the SceneObject itself and in its children.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The script type name (e.g., Interactable.getTypeName())) to find.
 * @param maxDepth - The maximum number of levels to search down the hierarchy (for children).
 * @returns An array of all matching Components found.
 */
export function findAllComponentsInSelfOrChildren<T extends BaseScriptComponent>(
  sceneObject: SceneObject,
  componentType: TypeName<T>,
  maxDepth?: number
): T[]

export function findAllComponentsInSelfOrChildren(
  sceneObject: SceneObject,
  componentType: keyof ComponentNameMap | TypeName<BaseScriptComponent>,
  maxDepth: number = DEFAULT_MAX_CHILD_SEARCH_LEVELS
): Component[] {
  return sceneObject.getComponentsInDescendants(componentType as any, false, true, maxDepth) as Component[]
}

/**
 * @deprecated Prefer `sceneObject.getComponentInAncestors(componentType, false, false, maxLevels)`.
 * [ByKey] Finds the first Component of a given type in the parents of a SceneObject, searching recursively upwards.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The string key of the component type to find (e.g., "Component.RenderMeshVisual").
 * @param maxLevels - The maximum number of levels to search up the hierarchy.
 * @returns The first matching Component found, or null if none is found.
 */
export function findComponentInParents<K extends keyof ComponentNameMap>(
  sceneObject: SceneObject,
  componentType: K,
  maxLevels?: number
): ComponentNameMap[K] | null

/**
 * @deprecated Prefer `sceneObject.getComponentInAncestors(componentType, false, false, maxLevels)`.
 * [ByScriptType] Finds the first Component of a given script type in the parents of a SceneObject, searching
 * recursively upwards.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The script type name (e.g., Interactable.getTypeName())) to find.
 * @param maxLevels - The maximum number of levels to search up the hierarchy.
 * @returns The first matching Component found, or null if none is found.
 */
export function findComponentInParents<T extends BaseScriptComponent>(
  sceneObject: SceneObject,
  componentType: TypeName<T>,
  maxLevels?: number
): T | null

export function findComponentInParents(
  sceneObject: SceneObject,
  componentType: keyof ComponentNameMap | TypeName<BaseScriptComponent>,
  maxLevels: number = DEFAULT_MAX_PARENT_SEARCH_LEVELS
): Component | null {
  return sceneObject.getComponentInAncestors(componentType as any, false, false, maxLevels)
}

/**
 * @deprecated Prefer `sceneObject.getComponentsInAncestors(componentType, false, false, maxLevels)`.
 * [ByKey] Finds all Components of a given type in the parents of a SceneObject, searching recursively upwards.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The string key of the component type to find (e.g., "Component.RenderMeshVisual").
 * @param maxLevels - The maximum number of levels to search up the hierarchy.
 * @returns An array of all matching Components found.
 */
export function findAllComponentsInParents<K extends keyof ComponentNameMap>(
  sceneObject: SceneObject,
  componentType: K,
  maxLevels?: number
): ComponentNameMap[K][]

/**
 * @deprecated Prefer `sceneObject.getComponentsInAncestors(componentType, false, false, maxLevels)`.
 * [ByScriptType] Finds all Components of a given script type in the parents of a SceneObject, searching recursively
 * upwards.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The script type name (e.g., Interactable.getTypeName())) to find.
 * @param maxLevels - The maximum number of levels to search up the hierarchy.
 * @returns An array of all matching Components found.
 */
export function findAllComponentsInParents<T extends BaseScriptComponent>(
  sceneObject: SceneObject,
  componentType: TypeName<T>,
  maxLevels?: number
): T[]

export function findAllComponentsInParents(
  sceneObject: SceneObject,
  componentType: keyof ComponentNameMap | TypeName<BaseScriptComponent>,
  maxLevels: number = DEFAULT_MAX_PARENT_SEARCH_LEVELS
): Component[] {
  return sceneObject.getComponentsInAncestors(componentType as any, false, false, maxLevels) as Component[]
}

/**
 * @deprecated Prefer `sceneObject.getComponentInAncestors(componentType, false, true, maxLevels + 1)`.
 * Note: native maxDepth counts self as a level, so pass maxLevels + 1 to match the old behavior.
 * [ByKey] Finds the first Component of a given type on the SceneObject itself or in its parents.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The string key of the component type to find (e.g., "Component.RenderMeshVisual").
 * @param maxLevels - The maximum number of levels to search up the hierarchy (for parents).
 * @returns The first matching Component found, or null if none is found.
 */
export function findComponentInSelfOrParents<K extends keyof ComponentNameMap>(
  sceneObject: SceneObject,
  componentType: K,
  maxLevels?: number
): ComponentNameMap[K] | null

/**
 * @deprecated Prefer `sceneObject.getComponentInAncestors(componentType, false, true, maxLevels + 1)`.
 * Note: native maxDepth counts self as a level, so pass maxLevels + 1 to match the old behavior.
 * [ByScriptType] Finds the first Component of a given script type on the SceneObject itself or in its parents.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The script type name (e.g., Interactable.getTypeName())) to find.
 * @param maxLevels - The maximum number of levels to search up the hierarchy (for parents).
 * @returns The first matching Component found, or null if none is found.
 */
export function findComponentInSelfOrParents<T extends BaseScriptComponent>(
  sceneObject: SceneObject,
  componentType: TypeName<T>,
  maxLevels?: number
): T | null

export function findComponentInSelfOrParents(
  sceneObject: SceneObject,
  componentType: keyof ComponentNameMap | TypeName<BaseScriptComponent>,
  maxLevels: number = DEFAULT_MAX_PARENT_SEARCH_LEVELS
): Component | null {
  // +1: old TS semantic was "check self + walk maxLevels parents"; native maxDepth counts self as a level
  return sceneObject.getComponentInAncestors(componentType as any, false, true, maxLevels + 1)
}

/**
 * @deprecated Prefer `sceneObject.getComponentsInAncestors(componentType, false, true, maxLevels + 1)`.
 * Note: native maxDepth counts self as a level, so pass maxLevels + 1 to match the old behavior.
 * [ByKey] Finds all Components of a given type on the SceneObject itself and in its parents.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The string key of the component type to find (e.g., "Component.RenderMeshVisual").
 * @param maxLevels - The maximum number of levels to search up the hierarchy (for parents).
 * @returns An array of all matching Components found.
 */
export function findAllComponentsInSelfOrParents<K extends keyof ComponentNameMap>(
  sceneObject: SceneObject,
  componentType: K,
  maxLevels?: number
): ComponentNameMap[K][]

/**
 * @deprecated Prefer `sceneObject.getComponentsInAncestors(componentType, false, true, maxLevels + 1)`.
 * Note: native maxDepth counts self as a level, so pass maxLevels + 1 to match the old behavior.
 * [ByScriptType] Finds all Components of a given script type on the SceneObject itself and in its parents.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The script type name (e.g., Interactable.getTypeName())) to find.
 * @param maxLevels - The maximum number of levels to search up the hierarchy (for parents).
 * @returns An array of all matching Components found.
 */
export function findAllComponentsInSelfOrParents<T extends BaseScriptComponent>(
  sceneObject: SceneObject,
  componentType: TypeName<T>,
  maxLevels?: number
): T[]

export function findAllComponentsInSelfOrParents(
  sceneObject: SceneObject,
  componentType: keyof ComponentNameMap | TypeName<BaseScriptComponent>,
  maxLevels: number = DEFAULT_MAX_PARENT_SEARCH_LEVELS
): Component[] {
  // +1: old TS semantic was "check self + walk maxLevels parents"; native maxDepth counts self as a level
  return sceneObject.getComponentsInAncestors(componentType as any, false, true, maxLevels + 1) as Component[]
}
