# sdlgl

`man @ecmaos/coreutils/sdlgl`

## Synopsis

```
sdlgl [WIDTH [HEIGHT]]
```

## Description

An OpenGL ES window, on SDL 3 through its Wayland driver; it needs `wlcomp` running and a browser with WebGL2.

A triangle with a red, a green and a blue corner turns in front of a light and is shaded by the angle it makes with it; its shaders, buffers and uniforms all go to the browser through `/dev/gl`. `R`, `G` and `B` make the window behind it red, green or blue, Space makes it gray, and Escape quits. It prints the GL version and renderer when it starts and the color name when it changes.

Programs of your own get OpenGL ES 2.0 through SDL (`SDL_WINDOW_OPENGL` with `SDL_GL_CONTEXT_PROFILE_ES`). The calls are not run in the program: they are packed into a stream that is written to a context node, `/dev/gl<N>` (made through `/dev/glctl`), and the browser's WebGL2 draws them. Each frame comes back as pixels and goes to the compositor like any other window content. Only the calls listed in `core/kernel/src/tree/lib/gl-commands.json` exist so far.
