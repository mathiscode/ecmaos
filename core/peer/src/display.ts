/**
 * The channel kind for a display. The side that opens it is a screen (a browser page) that shows the windows of the
 * machine it logged in to: the machine sends window messages, the screen sends back what the user did to them. Messages are
 * whole values over a `MessageStream`; their shapes belong to ecmaOS (`ToDisplay` and `ToKernel` in `@ecmaos/types`).
 */
export const DisplayChannel = 'display'
