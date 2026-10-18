# sdlgl

`man @ecmaos/coreutils/sdlgl`

## Synopsis

```
sdlgl [WIDTH [HEIGHT]]
```

## Description

An OpenGL ES window, on SDL 3 through its Wayland driver; it needs `wlcomp` running and a browser with WebGL2.

A triangle with a red, a green and a blue corner turns in front of a light and is shaded by the angle it makes with it; its shaders, buffers and uniforms all go to the browser through `/dev/gl`. `R`, `G` and `B` make the window behind it red, green or blue, Space makes it gray, `P` reads the pixel at the middle of the window back and prints it, and Escape quits. It prints the GL version and renderer when it starts, a shader's log if one does not build, and the color name when it changes.

Programs of your own get OpenGL ES 2.0 through SDL (`SDL_WINDOW_OPENGL` with `SDL_GL_CONTEXT_PROFILE_ES`). The calls are not run in the program: they are packed into a stream that is written to a context node, `/dev/gl<N>` (made through `/dev/glctl`), and the browser's WebGL2 draws them. Each frame comes back as pixels and goes to the compositor like any other window content. The calls that ask something (`glGetShaderiv`, `glGetProgramiv`, the info logs, `glGetAttribLocation`, `glGetIntegerv`, `glGetFloatv`, `glGetBooleanv`, `glGetActiveAttrib`, `glGetActiveUniform`, `glCheckFramebufferStatus` and `glReadPixels`) wait for the browser's answer, so a program that has to check its shaders works as it would anywhere; the others never wait. `glGetUniformLocation` does not ask: it never returns -1, and a uniform that the program does not have is ignored. Only the calls listed in `core/kernel/src/tree/lib/gl-commands.json` exist, and a window that is resized gets a context of its new size at its next frame. Not there: ES 3 and the WebGL2-only calls, multisampling, off-screen (pbuffer) surfaces, and client-memory vertex arrays drawn with an element buffer bound.
