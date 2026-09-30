import { RECIPES } from "../data/recipes";
import type { IngredientInstance, RecipeData } from "../types/game";

export class RecipeSystem {
  private readonly recipes: readonly RecipeData[];
  private readonly recipesById: ReadonlyMap<string, RecipeData>;
  private readonly recipesByDishId: ReadonlyMap<string, RecipeData>;

  constructor(recipes: readonly RecipeData[] = RECIPES) {
    this.recipes = [...recipes];
    this.recipesById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
    this.recipesByDishId = new Map(recipes.map((recipe) => [recipe.finalItemId, recipe]));
  }

  getAll(): readonly RecipeData[] {
    return this.recipes;
  }

  getRecipe(recipeId: string): RecipeData | undefined {
    return this.recipesById.get(recipeId);
  }

  getRecipeForDish(itemId: string): RecipeData | undefined {
    return this.recipesByDishId.get(itemId);
  }

  identifyRecipe(item: IngredientInstance | string): RecipeData | undefined {
    return this.getRecipeForDish(typeof item === "string" ? item : item.ingredientId);
  }

  isFinalDish(item: IngredientInstance | string): boolean {
    return this.identifyRecipe(item) !== undefined;
  }

  matchesRecipe(item: IngredientInstance | string, recipeId: string): boolean {
    return this.identifyRecipe(item)?.id === recipeId;
  }
}
