# sdlgears

`man @ecmaos/coreutils/sdlgears`

## Synopsis

```
sdlgears [WIDTH [HEIGHT]]
```

## Description

Three meshing gears in OpenGL ES 2, after the classic `glxgears`; it needs `wlcomp` running and a browser with WebGL2.

Each gear is a mesh in its own buffer, lit by one light and depth tested, so it exercises buffers, attribute pointers, uniforms and the depth buffer through `/dev/gl`. The arrow keys turn the view, Space pauses the gears, and Escape or closing the window quits. It prints the GL version and renderer when it starts and its frame rate every five seconds.

See `sdlgl` for how a program gets OpenGL ES and what is not there.
