/**
 * A number as a GLSL float literal, for values written into shader source.
 *
 * `String(96)` is `96`, an int, and GLSL will not multiply a float by an int:
 * the shader fails to compile, the program is invalid, and the thing it draws
 * is simply missing, with the reason only in the console.
 */
export function glslFloat(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}
