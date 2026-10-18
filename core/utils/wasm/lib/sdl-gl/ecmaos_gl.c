/*
  OpenGL ES for SDL on ecmaOS. Added to SDL's source tree by lib/sdl.sh; it is not part of SDL.

  SDL's Wayland driver draws OpenGL ES through EGL, which would be a GPU driver. Here the "GPU" is the browser's
  WebGL2, reached through the kernel's /dev/gl<N> (core/kernel/src/tree/lib/gl.ts): this file is the EGL and GLES2
  that SDL is linked with. Calls are packed into a command stream (ecmaos_gl_cmds.inc, generated from
  gl-commands.json), written to the context's node when it grows or a frame is asked for, and the picture comes back
  as pixels: eglSwapBuffers reads it into a wl_shm buffer and commits it, which is how a software client shows a
  window to the compositor.
*/
#include "SDL_internal.h"

#if defined(SDL_VIDEO_DRIVER_WAYLAND) && defined(SDL_VIDEO_OPENGL_EGL)

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

#include "../SDL_sysvideo.h"
#include "../SDL_egl_c.h"
#include "../wayland/SDL_waylandvideo.h"
#include <SDL3/SDL_opengles2.h>
#include <wayland-egl-backend.h>

extern int Wayland_CreateTempFD(off_t size);

#define GLCTL_CREATE 0x47c0
#define GL_SWAP_REQUEST 0x4700
#define GL_RESIZE_REQUEST 0x4701
#define GL_GETINFO_REQUEST 0x4702
#define GL_DESTROY_REQUEST 0x4703
#define GL_REPLY_REQUEST 0x4704
#define REPLY_MAX 1020 // the answer bytes one GL_REPLY gives, after a word with their count

#define ECMAOS_CONFIG ((EGLConfig)1)
#define ECMAOS_DISPLAY_FALLBACK ((EGLDisplay)1)
#define FLUSH_AT 65536

#define MAX_ATTRIBS 16
#define NO_BLOB 0xffffffffu
#define CHUNK 131072 // the most a record carries of a blob; a record has at most 65535 words

typedef struct
{
    GLboolean enabled;
    GLint size;
    GLenum type;
    GLboolean normalized;
    GLsizei stride;
    const void *pointer; // memory of the program, when no buffer was bound to the array
    GLuint scratch;      // the buffer its data is sent in for a draw
} Attrib;

typedef struct
{
    int fd;
    int width, height;
    Uint8 *stream;
    size_t used, capacity;
    uint32_t names; // the numbers of the objects the program has made; the kernel keeps the objects under them
    GLuint array_buffer, element_buffer, scratch_elements;
    GLint unpack_alignment, pack_alignment;
    uint8_t reply[4 + REPLY_MAX]; // answers fetched from the kernel and not yet used
    size_t reply_at, reply_have;
    Attrib attribs[MAX_ATTRIBS];
} Context;

typedef struct
{
    struct wl_buffer *buffer;
    void *pixels;
    bool busy;
} Slot;

typedef struct
{
    struct wl_egl_window *window;
    int width, height;
    struct wl_shm_pool *pool;
    void *memory;
    size_t memory_size;
    Slot slots[2];
    int next;
} Surface;

static EGLint last_error = EGL_SUCCESS;
static Context *current;

static bool fail(EGLint error)
{
    last_error = error;
    return false;
}

static uint32_t ecmaos_f2u(float f)
{
    uint32_t u;
    memcpy(&u, &f, 4);
    return u;
}

// - the command stream ---------------------------------------------------------------------------------

static bool flush_stream(Context *c)
{
    size_t done = 0;
    while (done < c->used) {
        const ssize_t n = write(c->fd, c->stream + done, c->used - done);
        if (n <= 0) {
            c->used = 0;
            return false;
        }
        done += (size_t)n;
    }
    c->used = 0;
    return true;
}

// room for a record of `count` payload words; returns where the payload goes, or NULL with no current context
static uint32_t *emit_reserve(unsigned op, size_t count)
{
    Context *c = current;
    const size_t need = 4 + count * 4;
    if (!c) {
        return NULL; // GL calls with no current context do nothing
    }
    if (c->used >= FLUSH_AT) {
        flush_stream(c);
    }
    if (c->used + need > c->capacity) {
        size_t capacity = c->capacity ? c->capacity : 4096;
        while (c->used + need > capacity) {
            capacity *= 2;
        }
        Uint8 *grown = (Uint8 *)SDL_realloc(c->stream, capacity);
        if (!grown) {
            return NULL;
        }
        c->stream = grown;
        c->capacity = capacity;
    }
    const uint32_t header = (op << 16) | (uint32_t)count;
    memcpy(c->stream + c->used, &header, 4);
    uint32_t *payload = (uint32_t *)(void *)(c->stream + c->used + 4);
    c->used += need;
    return payload;
}

static void ecmaos_emit(unsigned op, unsigned count, const uint32_t *words)
{
    uint32_t *payload = emit_reserve(op, count);
    if (payload && count) {
        memcpy(payload, words, (size_t)count * 4);
    }
}

// a record of plain words, a blob (`data` of `length` bytes, or none), and more plain words; at most CHUNK bytes of blob
static void emit_blob(unsigned op, const uint32_t *head, unsigned heads, const void *data, size_t length, const uint32_t *tail, unsigned tails)
{
    const size_t padded = data ? (length + 3) / 4 : 0;
    uint32_t *payload = emit_reserve(op, heads + 1 + padded + tails);
    if (!payload) {
        return;
    }
    if (heads) {
        memcpy(payload, head, (size_t)heads * 4);
    }
    payload[heads] = data ? (uint32_t)length : NO_BLOB;
    if (data) {
        if (padded) {
            payload[heads + padded] = 0;
        }
        memcpy(payload + heads + 1, data, length);
    }
    if (tails) {
        memcpy(payload + heads + 1 + padded, tail, (size_t)tails * 4);
    }
}

#include "ecmaos_gl_cmds.inc"

// - GLES2 calls that carry memory of the program or keep state here ---------------------------------------------

static uint32_t make_name(void)
{
    return current ? ++current->names : 0;
}

#define GEN_DELETE(Kind, create_op, delete_op) \
    GL_APICALL void GL_APIENTRY glGen##Kind##s(GLsizei n, GLuint *names) \
    { \
        for (GLsizei i = 0; i < n; i++) { \
            names[i] = make_name(); \
            ecmaos_emit(create_op, 1, &names[i]); \
        } \
    } \
    GL_APICALL void GL_APIENTRY glDelete##Kind##s(GLsizei n, const GLuint *names) \
    { \
        for (GLsizei i = 0; i < n; i++) { \
            if (names[i]) { \
                const uint32_t name = names[i]; \
                ecmaos_emit(delete_op, 1, &name); \
            } \
        } \
    }

GEN_DELETE(Texture, ECMAOS_OP_createTexture, ECMAOS_OP_deleteTexture)
GEN_DELETE(Framebuffer, ECMAOS_OP_createFramebuffer, ECMAOS_OP_deleteFramebuffer)
GEN_DELETE(Renderbuffer, ECMAOS_OP_createRenderbuffer, ECMAOS_OP_deleteRenderbuffer)

GL_APICALL void GL_APIENTRY glGenBuffers(GLsizei n, GLuint *names)
{
    for (GLsizei i = 0; i < n; i++) {
        names[i] = make_name();
        ecmaos_emit(ECMAOS_OP_createBuffer, 1, &names[i]);
    }
}

GL_APICALL void GL_APIENTRY glDeleteBuffers(GLsizei n, const GLuint *names)
{
    for (GLsizei i = 0; i < n; i++) {
        const uint32_t name = names[i];
        if (!name) {
            continue;
        }
        if (current && current->array_buffer == name) {
            current->array_buffer = 0;
        }
        if (current && current->element_buffer == name) {
            current->element_buffer = 0;
        }
        ecmaos_emit(ECMAOS_OP_deleteBuffer, 1, &name);
    }
}

GL_APICALL GLuint GL_APIENTRY glCreateShader(GLenum type)
{
    uint32_t w[2] = { type, make_name() };
    if (w[1]) {
        ecmaos_emit(ECMAOS_OP_createShader, 2, w);
    }
    return w[1];
}

GL_APICALL GLuint GL_APIENTRY glCreateProgram(void)
{
    uint32_t name = make_name();
    if (name) {
        ecmaos_emit(ECMAOS_OP_createProgram, 1, &name);
    }
    return name;
}

GL_APICALL void GL_APIENTRY glDeleteShader(GLuint shader)
{
    ecmaos_emit(ECMAOS_OP_deleteShader, 1, &shader);
}

GL_APICALL void GL_APIENTRY glDeleteProgram(GLuint program)
{
    ecmaos_emit(ECMAOS_OP_deleteProgram, 1, &program);
}

GL_APICALL void GL_APIENTRY glShaderSource(GLuint shader, GLsizei count, const GLchar *const *string, const GLint *length)
{
    size_t total = 0;
    for (GLsizei i = 0; i < count; i++) {
        total += length && length[i] >= 0 ? (size_t)length[i] : SDL_strlen(string[i]);
    }
    if (total > CHUNK) {
        return; // a shader this long is not one
    }
    char *text = (char *)SDL_malloc(total + 1);
    if (!text) {
        return;
    }
    size_t at = 0;
    for (GLsizei i = 0; i < count; i++) {
        const size_t n = length && length[i] >= 0 ? (size_t)length[i] : SDL_strlen(string[i]);
        memcpy(text + at, string[i], n);
        at += n;
    }
    emit_blob(ECMAOS_OP_shaderSource, &shader, 1, text, total, NULL, 0);
    SDL_free(text);
}

GL_APICALL void GL_APIENTRY glBindAttribLocation(GLuint program, GLuint index, const GLchar *name)
{
    const uint32_t head[2] = { program, index };
    emit_blob(ECMAOS_OP_bindAttribLocation, head, 2, name, SDL_strlen(name), NULL, 0);
}

GL_APICALL GLint GL_APIENTRY glGetUniformLocation(GLuint program, const GLchar *name)
{
    const uint32_t id = make_name();
    if (!id) {
        return -1;
    }
    emit_blob(ECMAOS_OP_getUniformLocation, &program, 1, name, SDL_strlen(name), &id, 1);
    return (GLint)id;
}

GL_APICALL void GL_APIENTRY glBindBuffer(GLenum target, GLuint buffer)
{
    const uint32_t w[2] = { target, buffer };
    if (current) {
        if (target == GL_ARRAY_BUFFER) {
            current->array_buffer = buffer;
        } else if (target == GL_ELEMENT_ARRAY_BUFFER) {
            current->element_buffer = buffer;
        }
    }
    ecmaos_emit(ECMAOS_OP_bindBuffer, 2, w);
}

GL_APICALL void GL_APIENTRY glBufferSubData(GLenum target, GLintptr offset, GLsizeiptr size, const void *data)
{
    for (GLsizeiptr done = 0; done < size; done += CHUNK) {
        const GLsizeiptr n = size - done < CHUNK ? size - done : CHUNK;
        const uint32_t head[2] = { target, (uint32_t)(offset + done) };
        emit_blob(ECMAOS_OP_bufferSubData, head, 2, (const Uint8 *)data + done, (size_t)n, NULL, 0);
    }
}

GL_APICALL void GL_APIENTRY glBufferData(GLenum target, GLsizeiptr size, const void *data, GLenum usage)
{
    const uint32_t w[3] = { target, (uint32_t)size, usage };
    ecmaos_emit(ECMAOS_OP_bufferDataSize, 3, w);
    if (data) {
        glBufferSubData(target, 0, size, data);
    }
}

static size_t pixel_size(GLenum format, GLenum type)
{
    switch (type) {
    case GL_UNSIGNED_SHORT_5_6_5:
    case GL_UNSIGNED_SHORT_4_4_4_4:
    case GL_UNSIGNED_SHORT_5_5_5_1:
        return 2;
    default:
        break;
    }
    size_t channels = 1;
    switch (format) {
    case GL_RGBA: channels = 4; break;
    case GL_RGB: channels = 3; break;
    case GL_LUMINANCE_ALPHA: channels = 2; break;
    default: break;
    }
    return channels * (type == GL_FLOAT ? 4 : type == GL_UNSIGNED_SHORT || type == GL_SHORT ? 2 : 1);
}

GL_APICALL void GL_APIENTRY glPixelStorei(GLenum name, GLint param)
{
    const uint32_t w[2] = { name, (uint32_t)param };
    if (current && name == GL_UNPACK_ALIGNMENT) {
        current->unpack_alignment = param;
    }
    if (current && name == GL_PACK_ALIGNMENT) {
        current->pack_alignment = param;
    }
    ecmaos_emit(ECMAOS_OP_pixelStorei, 2, w);
}

// A texture image of width by height pixels: sent whole when it fits a record, otherwise made empty and filled a band
// of rows at a time. `x` and `y` are where a sub-image goes; for a whole image `internalformat` and `border` are used.
static void send_pixels(bool sub, GLenum target, GLint level, GLint x, GLint y, GLint internalformat, GLsizei width, GLsizei height, GLint border, GLenum format, GLenum type, const void *pixels)
{
    const GLint align = current && current->unpack_alignment > 0 ? current->unpack_alignment : 4;
    const size_t bpp = pixel_size(format, type);
    const size_t row = (((size_t)width * bpp + align - 1) / align) * align;
    const size_t whole = height > 0 && width > 0 ? row * (size_t)(height - 1) + (size_t)width * bpp : 0;
    uint32_t words[8];
    if (sub) {
        const uint32_t h[8] = { target, (uint32_t)level, (uint32_t)x, (uint32_t)y, (uint32_t)width, (uint32_t)height, format, type };
        memcpy(words, h, sizeof h);
    } else {
        const uint32_t h[8] = { target, (uint32_t)level, (uint32_t)internalformat, (uint32_t)width, (uint32_t)height, (uint32_t)border, format, type };
        memcpy(words, h, sizeof h);
    }
    const unsigned op = sub ? ECMAOS_OP_texSubImage2D : ECMAOS_OP_texImage2D;
    if (!pixels || whole <= CHUNK) {
        emit_blob(op, words, 8, pixels, whole, NULL, 0);
        return;
    }
    if (!sub) {
        emit_blob(op, words, 8, NULL, 0, NULL, 0);
    }
    const GLsizei rows = (GLsizei)(CHUNK / row > 0 ? CHUNK / row : 1);
    for (GLsizei top = 0; top < height; top += rows) {
        const GLsizei n = height - top < rows ? height - top : rows;
        const uint32_t band[8] = { target, (uint32_t)level, (uint32_t)(sub ? x : 0), (uint32_t)((sub ? y : 0) + top), (uint32_t)width, (uint32_t)n, format, type };
        emit_blob(ECMAOS_OP_texSubImage2D, band, 8, (const Uint8 *)pixels + (size_t)top * row, row * (size_t)(n - 1) + (size_t)width * bpp, NULL, 0);
    }
}

GL_APICALL void GL_APIENTRY glTexImage2D(GLenum target, GLint level, GLint internalformat, GLsizei width, GLsizei height, GLint border, GLenum format, GLenum type, const void *pixels)
{
    send_pixels(false, target, level, 0, 0, internalformat, width, height, border, format, type, pixels);
}

GL_APICALL void GL_APIENTRY glTexSubImage2D(GLenum target, GLint level, GLint xoffset, GLint yoffset, GLsizei width, GLsizei height, GLenum format, GLenum type, const void *pixels)
{
    send_pixels(true, target, level, xoffset, yoffset, 0, width, height, 0, format, type, pixels);
}

#define UNIFORM_V(n, letter, Type) \
    GL_APICALL void GL_APIENTRY glUniform##n##letter##v(GLint location, GLsizei count, const Type *value) \
    { \
        const uint32_t head = (uint32_t)location; \
        const size_t bytes = (size_t)count * n * 4; \
        if (value && bytes <= CHUNK) { \
            emit_blob(ECMAOS_OP_uniform##n##letter##v, &head, 1, value, bytes, NULL, 0); \
        } \
    }

UNIFORM_V(1, f, GLfloat)
UNIFORM_V(2, f, GLfloat)
UNIFORM_V(3, f, GLfloat)
UNIFORM_V(4, f, GLfloat)
UNIFORM_V(1, i, GLint)
UNIFORM_V(2, i, GLint)
UNIFORM_V(3, i, GLint)
UNIFORM_V(4, i, GLint)

#define UNIFORM_MATRIX(n) \
    GL_APICALL void GL_APIENTRY glUniformMatrix##n##fv(GLint location, GLsizei count, GLboolean transpose, const GLfloat *value) \
    { \
        const uint32_t head[2] = { (uint32_t)location, transpose }; \
        const size_t bytes = (size_t)count * n * n * 4; \
        if (value && bytes <= CHUNK) { \
            emit_blob(ECMAOS_OP_uniformMatrix##n##fv, head, 2, value, bytes, NULL, 0); \
        } \
    }

UNIFORM_MATRIX(2)
UNIFORM_MATRIX(3)
UNIFORM_MATRIX(4)

#define VERTEX_ATTRIB_V(n) \
    GL_APICALL void GL_APIENTRY glVertexAttrib##n##fv(GLuint index, const GLfloat *v) \
    { \
        emit_blob(ECMAOS_OP_vertexAttrib##n##fv, &index, 1, v, n * 4, NULL, 0); \
    }

VERTEX_ATTRIB_V(1)
VERTEX_ATTRIB_V(2)
VERTEX_ATTRIB_V(3)
VERTEX_ATTRIB_V(4)

// - vertex arrays: the browser takes only arrays in buffers, GLES2 also takes the program's own memory ----------

GL_APICALL void GL_APIENTRY glEnableVertexAttribArray(GLuint index)
{
    if (current && index < MAX_ATTRIBS) {
        current->attribs[index].enabled = GL_TRUE;
    }
    ecmaos_emit(ECMAOS_OP_enableVertexAttribArray, 1, &index);
}

GL_APICALL void GL_APIENTRY glDisableVertexAttribArray(GLuint index)
{
    if (current && index < MAX_ATTRIBS) {
        current->attribs[index].enabled = GL_FALSE;
    }
    ecmaos_emit(ECMAOS_OP_disableVertexAttribArray, 1, &index);
}

GL_APICALL void GL_APIENTRY glVertexAttribPointer(GLuint index, GLint size, GLenum type, GLboolean normalized, GLsizei stride, const void *pointer)
{
    if (!current || index >= MAX_ATTRIBS) {
        return;
    }
    Attrib *a = &current->attribs[index];
    a->size = size;
    a->type = type;
    a->normalized = normalized;
    a->stride = stride;
    if (current->array_buffer == 0) {
        a->pointer = pointer; // sent with the draw that uses it
        return;
    }
    a->pointer = NULL;
    const uint32_t w[6] = { index, (uint32_t)size, type, normalized, (uint32_t)stride, (uint32_t)(uintptr_t)pointer };
    ecmaos_emit(ECMAOS_OP_vertexAttribPointer, 6, w);
}

static size_t type_size(GLenum type)
{
    return type == GL_BYTE || type == GL_UNSIGNED_BYTE ? 1 : type == GL_SHORT || type == GL_UNSIGNED_SHORT ? 2 : 4;
}

static bool has_client_arrays(void)
{
    for (int i = 0; i < MAX_ATTRIBS; i++) {
        if (current->attribs[i].enabled && current->attribs[i].pointer) {
            return true;
        }
    }
    return false;
}

// Sends the first `vertices` vertices of the arrays that live in the program's memory into buffers made for the
// purpose and points the attributes at them; the program's own array buffer binding is put back afterwards.
static void send_client_arrays(size_t vertices)
{
    Context *c = current;
    for (GLuint i = 0; i < MAX_ATTRIBS; i++) {
        Attrib *a = &c->attribs[i];
        if (!a->enabled || !a->pointer) {
            continue;
        }
        if (!a->scratch) {
            a->scratch = make_name();
            ecmaos_emit(ECMAOS_OP_createBuffer, 1, &a->scratch);
        }
        const size_t packed = (size_t)a->size * type_size(a->type);
        const size_t stride = a->stride ? (size_t)a->stride : packed;
        const size_t length = vertices ? stride * (vertices - 1) + packed : 0;
        const uint32_t bind[2] = { GL_ARRAY_BUFFER, a->scratch };
        ecmaos_emit(ECMAOS_OP_bindBuffer, 2, bind);
        const uint32_t size[3] = { GL_ARRAY_BUFFER, (uint32_t)length, GL_STREAM_DRAW };
        ecmaos_emit(ECMAOS_OP_bufferDataSize, 3, size);
        for (size_t done = 0; done < length; done += CHUNK) {
            const size_t n = length - done < CHUNK ? length - done : CHUNK;
            const uint32_t head[2] = { GL_ARRAY_BUFFER, (uint32_t)done };
            emit_blob(ECMAOS_OP_bufferSubData, head, 2, (const Uint8 *)a->pointer + done, n, NULL, 0);
        }
        const uint32_t pointer[6] = { i, (uint32_t)a->size, a->type, a->normalized, (uint32_t)a->stride, 0 };
        ecmaos_emit(ECMAOS_OP_vertexAttribPointer, 6, pointer);
    }
    const uint32_t restore[2] = { GL_ARRAY_BUFFER, c->array_buffer };
    ecmaos_emit(ECMAOS_OP_bindBuffer, 2, restore);
}

GL_APICALL void GL_APIENTRY glDrawArrays(GLenum mode, GLint first, GLsizei count)
{
    if (!current || count < 0 || first < 0) {
        return;
    }
    if (has_client_arrays()) {
        send_client_arrays((size_t)first + (size_t)count);
    }
    const uint32_t w[3] = { mode, (uint32_t)first, (uint32_t)count };
    ecmaos_emit(ECMAOS_OP_drawArrays, 3, w);
}

GL_APICALL void GL_APIENTRY glDrawElements(GLenum mode, GLsizei count, GLenum type, const void *indices)
{
    if (!current || count < 0) {
        return;
    }
    const size_t bytes = type_size(type);
    if (current->element_buffer) { // the indices are in a buffer, and so have to be the arrays
        const uint32_t w[4] = { mode, (uint32_t)count, type, (uint32_t)(uintptr_t)indices };
        ecmaos_emit(ECMAOS_OP_drawElements, 4, w);
        return;
    }
    if (!indices || (type != GL_UNSIGNED_BYTE && type != GL_UNSIGNED_SHORT) || (size_t)count * bytes > CHUNK) {
        return;
    }
    size_t highest = 0;
    for (GLsizei i = 0; i < count; i++) {
        const size_t index = bytes == 1 ? ((const Uint8 *)indices)[i] : ((const Uint16 *)indices)[i];
        if (index > highest) {
            highest = index;
        }
    }
    if (has_client_arrays()) {
        send_client_arrays(highest + 1);
    }
    if (!current->scratch_elements) {
        current->scratch_elements = make_name();
        ecmaos_emit(ECMAOS_OP_createBuffer, 1, &current->scratch_elements);
    }
    const uint32_t bind[2] = { GL_ELEMENT_ARRAY_BUFFER, current->scratch_elements };
    ecmaos_emit(ECMAOS_OP_bindBuffer, 2, bind);
    const uint32_t size[3] = { GL_ELEMENT_ARRAY_BUFFER, (uint32_t)((size_t)count * bytes), GL_STREAM_DRAW };
    ecmaos_emit(ECMAOS_OP_bufferDataSize, 3, size);
    const uint32_t head[2] = { GL_ELEMENT_ARRAY_BUFFER, 0 };
    emit_blob(ECMAOS_OP_bufferSubData, head, 2, indices, (size_t)count * bytes, NULL, 0);
    const uint32_t draw[4] = { mode, (uint32_t)count, type, 0 };
    ecmaos_emit(ECMAOS_OP_drawElements, 4, draw);
    const uint32_t restore[2] = { GL_ELEMENT_ARRAY_BUFFER, current->element_buffer };
    ecmaos_emit(ECMAOS_OP_bindBuffer, 2, restore);
}

static bool open_context(Context *c, int width, int height)
{
    uint32_t size[2] = { (uint32_t)width, (uint32_t)height };
    const int control = open("/dev/glctl", O_RDWR);
    if (control < 0) {
        return false;
    }
    const int made = ioctl(control, GLCTL_CREATE, size);
    close(control);
    if (made != 0) {
        return false;
    }
    char path[32];
    SDL_snprintf(path, sizeof path, "/dev/gl%u", (unsigned)size[0]);
    c->fd = open(path, O_RDWR);
    if (c->fd < 0) {
        return false;
    }
    c->width = width;
    c->height = height;
    return true;
}

static bool query_info(Context *c, uint32_t info[4])
{
    return flush_stream(c) && ioctl(c->fd, GL_GETINFO_REQUEST, info) == 0;
}

// - GLES2 calls that are answered here ----------------------------------------------------------------------

GL_APICALL GLenum GL_APIENTRY glGetError(void)
{
    uint32_t info[4] = { 0, 0, 0, 0 };
    if (!current || !query_info(current, info)) {
        return GL_NO_ERROR;
    }
    return (GLenum)info[3];
}

GL_APICALL void GL_APIENTRY glFlush(void)
{
    if (current) {
        flush_stream(current);
    }
}

GL_APICALL void GL_APIENTRY glFinish(void)
{
    glFlush();
}

GL_APICALL const GLubyte *GL_APIENTRY glGetString(GLenum name)
{
    switch (name) {
    case GL_VENDOR:
        return (const GLubyte *)"ecmaOS";
    case GL_RENDERER:
        return (const GLubyte *)"WebGL2 through /dev/gl";
    case GL_VERSION:
        return (const GLubyte *)"OpenGL ES 2.0 ecmaOS";
    case GL_SHADING_LANGUAGE_VERSION:
        return (const GLubyte *)"OpenGL ES GLSL ES 1.00";
    case GL_EXTENSIONS:
        return (const GLubyte *)"";
    default:
        return NULL;
    }
}

// - questions: GLES2 calls the browser answers ----------------------------------------------------------
//
// A question is a record in the stream like any call; the kernel keeps its answer, and the program fetches the answers
// with GL_REPLY once the stream is flushed. The kernel answers every question (with zeros if it fails), so a fetch that
// comes back short means a broken device and the rest is zeros.

// the next `n` bytes of answer into `out` (dropped if NULL), or zeros once the kernel has no more
static bool reply_take(Context *c, void *out, size_t n)
{
    Uint8 *to = (Uint8 *)out;
    while (n) {
        if (c->reply_at >= c->reply_have) {
            uint8_t buffer[4 + REPLY_MAX];
            uint32_t count = 0;
            if (ioctl(c->fd, GL_REPLY_REQUEST, buffer) != 0) {
                break;
            }
            memcpy(&count, buffer, 4);
            if (count == 0 || count > REPLY_MAX) {
                break;
            }
            memcpy(c->reply, buffer + 4, count);
            c->reply_at = 0;
            c->reply_have = count;
        }
        size_t take = c->reply_have - c->reply_at;
        if (take > n) {
            take = n;
        }
        if (to) {
            memcpy(to, c->reply + c->reply_at, take);
            to += take;
        }
        c->reply_at += take;
        n -= take;
    }
    if (n && to) {
        memset(to, 0, n);
    }
    return n == 0;
}

static int32_t reply_int(Context *c)
{
    int32_t value = 0;
    reply_take(c, &value, 4);
    return value;
}

// a text answer: its length, then its bytes, of which `size` - 1 are kept
static void reply_text(Context *c, GLsizei size, GLsizei *length, GLchar *out)
{
    const uint32_t n = (uint32_t)reply_int(c);
    const uint32_t keep = size > 0 ? (n < (uint32_t)(size - 1) ? n : (uint32_t)(size - 1)) : 0;
    if (out && size > 0) {
        reply_take(c, out, keep);
        out[keep] = 0;
    } else {
        reply_take(c, NULL, keep);
    }
    reply_take(c, NULL, n - keep);
    if (length) {
        *length = (GLsizei)keep;
    }
}

// sends a question with no text and makes the stream reach the kernel; the answer is next in the replies
static Context *ask(unsigned op, unsigned count, const uint32_t *words)
{
    Context *c = current;
    if (!c) {
        return NULL;
    }
    ecmaos_emit(op, count, words);
    return flush_stream(c) ? c : NULL;
}

GL_APICALL GLint GL_APIENTRY glGetAttribLocation(GLuint program, const GLchar *name)
{
    Context *c = current;
    if (!c) {
        return -1;
    }
    emit_blob(ECMAOS_OP_getAttribLocation, &program, 1, name, SDL_strlen(name), NULL, 0);
    return flush_stream(c) ? reply_int(c) : -1;
}

GL_APICALL void GL_APIENTRY glGetShaderiv(GLuint shader, GLenum pname, GLint *params)
{
    const uint32_t w[2] = { shader, pname };
    Context *c = ask(ECMAOS_OP_getShaderiv, 2, w);
    *params = c ? reply_int(c) : 0;
}

GL_APICALL void GL_APIENTRY glGetProgramiv(GLuint program, GLenum pname, GLint *params)
{
    const uint32_t w[2] = { program, pname };
    Context *c = ask(ECMAOS_OP_getProgramiv, 2, w);
    *params = c ? reply_int(c) : 0;
}

GL_APICALL void GL_APIENTRY glGetShaderInfoLog(GLuint shader, GLsizei size, GLsizei *length, GLchar *log)
{
    Context *c = ask(ECMAOS_OP_getShaderInfoLog, 1, &shader);
    if (c) {
        reply_text(c, size, length, log);
    } else if (length) {
        *length = 0;
    }
}

GL_APICALL void GL_APIENTRY glGetProgramInfoLog(GLuint program, GLsizei size, GLsizei *length, GLchar *log)
{
    Context *c = ask(ECMAOS_OP_getProgramInfoLog, 1, &program);
    if (c) {
        reply_text(c, size, length, log);
    } else if (length) {
        *length = 0;
    }
}

GL_APICALL GLenum GL_APIENTRY glCheckFramebufferStatus(GLenum target)
{
    Context *c = ask(ECMAOS_OP_checkFramebufferStatus, 1, &target);
    return c ? (GLenum)reply_int(c) : 0;
}

static void get_values(unsigned op, GLenum name, void *values, bool floats)
{
    Context *c = ask(op, 1, &name);
    if (!c) {
        return;
    }
    const uint32_t n = (uint32_t)reply_int(c);
    for (uint32_t i = 0; i < n; i++) {
        uint32_t word = (uint32_t)reply_int(c);
        if (i < 16) {
            if (floats) {
                memcpy((float *)values + i, &word, 4);
            } else {
                ((int32_t *)values)[i] = (int32_t)word;
            }
        }
    }
}

GL_APICALL void GL_APIENTRY glGetIntegerv(GLenum name, GLint *values)
{
    values[0] = 0;
    get_values(ECMAOS_OP_getIntegerv, name, values, false);
}

GL_APICALL void GL_APIENTRY glGetBooleanv(GLenum name, GLboolean *values)
{
    GLint wide[16] = { 0 };
    get_values(ECMAOS_OP_getIntegerv, name, wide, false);
    for (int i = 0; i < 4; i++) {
        values[i] = wide[i] != 0; // as many as the largest answer that is a boolean (a color mask)
    }
}

GL_APICALL void GL_APIENTRY glGetFloatv(GLenum name, GLfloat *values)
{
    values[0] = 0;
    get_values(ECMAOS_OP_getFloatv, name, values, true);
}

GL_APICALL void GL_APIENTRY glReadPixels(GLint x, GLint y, GLsizei width, GLsizei height, GLenum format, GLenum type, void *pixels)
{
    const uint32_t w[6] = { (uint32_t)x, (uint32_t)y, (uint32_t)width, (uint32_t)height, format, type };
    Context *c = ask(ECMAOS_OP_readPixels, 6, w);
    if (!c || width <= 0 || height <= 0) {
        return;
    }
    const GLint align = c->pack_alignment > 0 ? c->pack_alignment : 4;
    const size_t unit = pixel_size(format, type);
    const size_t row = ((size_t)width * unit + (size_t)align - 1) / (size_t)align * (size_t)align;
    reply_take(c, pixels, row * (size_t)(height - 1) + (size_t)width * unit);
}

static void get_active(unsigned op, GLuint program, GLuint index, GLsizei size, GLsizei *length, GLint *out_size, GLenum *type, GLchar *name)
{
    const uint32_t w[2] = { program, index };
    Context *c = ask(op, 2, w);
    if (!c) {
        if (length) {
            *length = 0;
        }
        return;
    }
    const int32_t count = reply_int(c);
    const uint32_t kind = (uint32_t)reply_int(c);
    if (out_size) {
        *out_size = count;
    }
    if (type) {
        *type = kind;
    }
    reply_text(c, size, length, name);
}

GL_APICALL void GL_APIENTRY glGetActiveAttrib(GLuint program, GLuint index, GLsizei size, GLsizei *length, GLint *out_size, GLenum *type, GLchar *name)
{
    get_active(ECMAOS_OP_getActiveAttrib, program, index, size, length, out_size, type, name);
}

GL_APICALL void GL_APIENTRY glGetActiveUniform(GLuint program, GLuint index, GLsizei size, GLsizei *length, GLint *out_size, GLenum *type, GLchar *name)
{
    get_active(ECMAOS_OP_getActiveUniform, program, index, size, length, out_size, type, name);
}

// - EGL ------------------------------------------------------------------------------------------------

EGLAPI EGLint EGLAPIENTRY eglGetError(void)
{
    const EGLint error = last_error;
    last_error = EGL_SUCCESS;
    return error;
}

EGLAPI EGLDisplay EGLAPIENTRY eglGetDisplay(EGLNativeDisplayType native)
{
    return native ? (EGLDisplay)native : ECMAOS_DISPLAY_FALLBACK;
}

EGLAPI EGLDisplay EGLAPIENTRY eglGetPlatformDisplay(EGLenum platform, void *native, const EGLAttrib *attribs)
{
    return native ? (EGLDisplay)native : ECMAOS_DISPLAY_FALLBACK;
}

EGLAPI EGLBoolean EGLAPIENTRY eglInitialize(EGLDisplay display, EGLint *major, EGLint *minor)
{
    if (major) {
        *major = 1;
    }
    if (minor) {
        *minor = 4;
    }
    return EGL_TRUE;
}

EGLAPI EGLBoolean EGLAPIENTRY eglTerminate(EGLDisplay display)
{
    return EGL_TRUE;
}

EGLAPI const char *EGLAPIENTRY eglQueryString(EGLDisplay display, EGLint name)
{
    switch (name) {
    case EGL_VENDOR:
        return "ecmaOS";
    case EGL_VERSION:
        return "1.4 ecmaOS";
    case EGL_CLIENT_APIS:
        return "OpenGL_ES";
    case EGL_EXTENSIONS:
        return "";
    default:
        last_error = EGL_BAD_PARAMETER;
        return NULL;
    }
}

EGLAPI EGLBoolean EGLAPIENTRY eglBindAPI(EGLenum api)
{
    return api == EGL_OPENGL_ES_API ? EGL_TRUE : fail(EGL_BAD_PARAMETER);
}

// the one configuration there is: 8 bits a channel, 24 of depth and 8 of stencil, no multisampling
static bool config_value(EGLint attribute, EGLint *value)
{
    switch (attribute) {
    case EGL_BUFFER_SIZE: *value = 32; break;
    case EGL_RED_SIZE: case EGL_GREEN_SIZE: case EGL_BLUE_SIZE: case EGL_ALPHA_SIZE: *value = 8; break;
    case EGL_DEPTH_SIZE: *value = 24; break;
    case EGL_STENCIL_SIZE: *value = 8; break;
    case EGL_SAMPLES: case EGL_SAMPLE_BUFFERS: case EGL_LEVEL: case EGL_LUMINANCE_SIZE: case EGL_ALPHA_MASK_SIZE: *value = 0; break;
    case EGL_SURFACE_TYPE: *value = EGL_WINDOW_BIT; break;
    case EGL_RENDERABLE_TYPE: case EGL_CONFORMANT: *value = EGL_OPENGL_ES2_BIT; break;
    case EGL_CONFIG_ID: *value = 1; break;
    case EGL_NATIVE_RENDERABLE: *value = EGL_TRUE; break;
    case EGL_NATIVE_VISUAL_ID: case EGL_NATIVE_VISUAL_TYPE: *value = 0; break;
    case EGL_CONFIG_CAVEAT: case EGL_TRANSPARENT_TYPE: *value = EGL_NONE; break;
    case EGL_COLOR_BUFFER_TYPE: *value = EGL_RGB_BUFFER; break;
    case EGL_BIND_TO_TEXTURE_RGB: case EGL_BIND_TO_TEXTURE_RGBA: *value = EGL_FALSE; break;
    case EGL_MAX_PBUFFER_WIDTH: case EGL_MAX_PBUFFER_HEIGHT: *value = 4096; break;
    case EGL_MAX_PBUFFER_PIXELS: *value = 4096 * 4096; break;
    case EGL_MAX_SWAP_INTERVAL: *value = 1; break;
    case EGL_MIN_SWAP_INTERVAL: *value = 0; break;
    default: return false;
    }
    return true;
}

EGLAPI EGLBoolean EGLAPIENTRY eglGetConfigAttrib(EGLDisplay display, EGLConfig config, EGLint attribute, EGLint *value)
{
    return config_value(attribute, value) ? EGL_TRUE : fail(EGL_BAD_ATTRIBUTE);
}

EGLAPI EGLBoolean EGLAPIENTRY eglChooseConfig(EGLDisplay display, const EGLint *attribs, EGLConfig *configs, EGLint size, EGLint *count)
{
    bool match = true;
    for (; attribs && *attribs != EGL_NONE; attribs += 2) {
        EGLint have;
        const EGLint want = attribs[1];
        if (want == EGL_DONT_CARE || !config_value(attribs[0], &have)) {
            continue;
        }
        switch (attribs[0]) {
        case EGL_RED_SIZE: case EGL_GREEN_SIZE: case EGL_BLUE_SIZE: case EGL_ALPHA_SIZE: case EGL_BUFFER_SIZE:
        case EGL_DEPTH_SIZE: case EGL_STENCIL_SIZE:
            match = match && want <= have;
            break;
        case EGL_SAMPLES: case EGL_SAMPLE_BUFFERS:
            match = match && want == 0;
            break;
        case EGL_SURFACE_TYPE:
            match = match && (want & ~(EGL_WINDOW_BIT | EGL_PBUFFER_BIT)) == 0 && (want & EGL_WINDOW_BIT || !want);
            break;
        case EGL_RENDERABLE_TYPE: case EGL_CONFORMANT:
            match = match && (want & ~(EGL_OPENGL_ES2_BIT | EGL_OPENGL_ES3_BIT)) == 0;
            break;
        default:
            break;
        }
    }
    if (count) {
        *count = match ? 1 : 0;
    }
    if (match && configs && size > 0) {
        configs[0] = ECMAOS_CONFIG;
    }
    return EGL_TRUE;
}

EGLAPI EGLContext EGLAPIENTRY eglCreateContext(EGLDisplay display, EGLConfig config, EGLContext share, const EGLint *attribs)
{
    EGLint version = 1;
    for (; attribs && *attribs != EGL_NONE; attribs += 2) {
        if (attribs[0] == EGL_CONTEXT_CLIENT_VERSION) {
            version = attribs[1];
        }
    }
    if (version < 2) {
        fail(EGL_BAD_CONFIG);
        return EGL_NO_CONTEXT;
    }
    Context *c = (Context *)SDL_calloc(1, sizeof(*c));
    if (!c) {
        fail(EGL_BAD_ALLOC);
        return EGL_NO_CONTEXT;
    }
    c->fd = -1;
    c->unpack_alignment = 4;
    c->pack_alignment = 4;
    return (EGLContext)c;
}

EGLAPI EGLBoolean EGLAPIENTRY eglDestroyContext(EGLDisplay display, EGLContext context)
{
    Context *c = (Context *)context;
    if (!c) {
        return fail(EGL_BAD_CONTEXT);
    }
    if (current == c) {
        current = NULL;
    }
    if (c->fd >= 0) {
        ioctl(c->fd, GL_DESTROY_REQUEST, NULL);
        close(c->fd);
    }
    SDL_free(c->stream);
    SDL_free(c);
    return EGL_TRUE;
}

EGLAPI EGLSurface EGLAPIENTRY eglCreateWindowSurface(EGLDisplay display, EGLConfig config, EGLNativeWindowType window, const EGLint *attribs)
{
    struct wl_egl_window *win = (struct wl_egl_window *)window;
    Surface *s = win ? (Surface *)SDL_calloc(1, sizeof(*s)) : NULL;
    if (!s) {
        fail(win ? EGL_BAD_ALLOC : EGL_BAD_NATIVE_WINDOW);
        return EGL_NO_SURFACE;
    }
    s->window = win;
    s->width = win->width;
    s->height = win->height;
    return (EGLSurface)s;
}

EGLAPI EGLSurface EGLAPIENTRY eglCreatePbufferSurface(EGLDisplay display, EGLConfig config, const EGLint *attribs)
{
    fail(EGL_BAD_ALLOC);
    return EGL_NO_SURFACE;
}

static void release_slots(Surface *s)
{
    for (int i = 0; i < 2; i++) {
        if (s->slots[i].buffer) {
            wl_buffer_destroy(s->slots[i].buffer);
        }
        SDL_zero(s->slots[i]);
    }
    if (s->pool) {
        wl_shm_pool_destroy(s->pool);
        s->pool = NULL;
    }
    if (s->memory) {
        munmap(s->memory, s->memory_size);
        s->memory = NULL;
    }
}

EGLAPI EGLBoolean EGLAPIENTRY eglDestroySurface(EGLDisplay display, EGLSurface surface)
{
    Surface *s = (Surface *)surface;
    if (!s) {
        return fail(EGL_BAD_SURFACE);
    }
    release_slots(s);
    SDL_free(s);
    return EGL_TRUE;
}

EGLAPI EGLBoolean EGLAPIENTRY eglMakeCurrent(EGLDisplay display, EGLSurface draw, EGLSurface read, EGLContext context)
{
    Context *c = (Context *)context;
    Surface *s = (Surface *)draw;
    if (current) {
        flush_stream(current);
    }
    if (!c) {
        current = NULL;
        return EGL_TRUE;
    }
    if (c->fd < 0 && !open_context(c, s ? s->window->width : 1, s ? s->window->height : 1)) {
        return fail(EGL_BAD_ALLOC);
    }
    current = c;
    return EGL_TRUE;
}

static void buffer_released(void *data, struct wl_buffer *buffer)
{
    ((Slot *)data)->busy = false;
}

static const struct wl_buffer_listener buffer_listener = { buffer_released };

static bool make_slots(Surface *s, SDL_VideoData *video)
{
    const size_t pitch = (size_t)s->width * 4;
    const size_t one = pitch * s->height;
    release_slots(s);
    s->memory_size = one * 2;
    const int fd = Wayland_CreateTempFD((off_t)s->memory_size);
    if (fd < 0) {
        return false;
    }
    s->memory = mmap(NULL, s->memory_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (s->memory == MAP_FAILED) {
        s->memory = NULL;
        close(fd);
        return false;
    }
    s->pool = wl_shm_create_pool(video->shm, fd, (int32_t)s->memory_size);
    close(fd);
    for (int i = 0; i < 2; i++) {
        Slot *slot = &s->slots[i];
        slot->pixels = (Uint8 *)s->memory + i * one;
        slot->buffer = wl_shm_pool_create_buffer(s->pool, (int32_t)(i * one), s->width, s->height, (int32_t)pitch, WL_SHM_FORMAT_XRGB8888);
        wl_buffer_add_listener(slot->buffer, &buffer_listener, slot);
    }
    s->next = 0;
    return true;
}

EGLAPI EGLBoolean EGLAPIENTRY eglSwapBuffers(EGLDisplay display, EGLSurface surface)
{
    Surface *s = (Surface *)surface;
    Context *c = current;
    SDL_VideoDevice *device = SDL_GetVideoDevice();
    SDL_VideoData *video = device ? device->internal : NULL;

    if (!s || !video || !video->shm) {
        return fail(EGL_BAD_SURFACE);
    }
    if (!c) {
        return fail(EGL_BAD_CONTEXT);
    }
    // the window has been resized: a new size for the context and for the buffers
    const int width = s->window->width, height = s->window->height;
    if (width < 1 || height < 1) {
        return EGL_TRUE;
    }
    if (!flush_stream(c)) {
        return fail(EGL_CONTEXT_LOST);
    }
    if (width != c->width || height != c->height) {
        uint32_t size[2] = { (uint32_t)width, (uint32_t)height };
        if (ioctl(c->fd, GL_RESIZE_REQUEST, size) != 0) {
            return fail(EGL_BAD_ALLOC);
        }
        c->width = width;
        c->height = height;
    }
    if (!s->pool || width != s->width || height != s->height) {
        s->width = width;
        s->height = height;
        if (!make_slots(s, video)) {
            return fail(EGL_BAD_ALLOC);
        }
    }

    uint32_t frames = 0;
    if (ioctl(c->fd, GL_SWAP_REQUEST, &frames) != 0) {
        return fail(EGL_CONTEXT_LOST);
    }

    // a buffer the compositor has let go of
    Slot *slot = &s->slots[s->next];
    if (slot->busy) {
        for (int tries = 0; tries < 8 && slot->busy; tries++) {
            wl_display_roundtrip(video->display);
        }
        if (slot->busy && !s->slots[s->next ^ 1].busy) {
            slot = &s->slots[s->next ^ 1];
        }
    }
    s->next = (int)(slot - s->slots) ^ 1;

    const size_t total = (size_t)width * height * 4;
    size_t done = 0;
    while (done < total) {
        const ssize_t n = read(c->fd, (Uint8 *)slot->pixels + done, total - done);
        if (n <= 0) {
            return fail(EGL_CONTEXT_LOST);
        }
        done += (size_t)n;
    }

    struct wl_surface *surface_proxy = s->window->surface;
    wl_surface_attach(surface_proxy, slot->buffer, 0, 0);
    slot->busy = true;
    if (wl_compositor_get_version(video->compositor) >= WL_SURFACE_DAMAGE_BUFFER_SINCE_VERSION) {
        wl_surface_damage_buffer(surface_proxy, 0, 0, SDL_MAX_SINT32, SDL_MAX_SINT32);
    } else {
        wl_surface_damage(surface_proxy, 0, 0, SDL_MAX_SINT32, SDL_MAX_SINT32);
    }
    wl_surface_commit(surface_proxy);
    wl_display_flush(video->display);
    return EGL_TRUE;
}

EGLAPI EGLBoolean EGLAPIENTRY eglSwapInterval(EGLDisplay display, EGLint interval)
{
    return EGL_TRUE; // SDL paces the frames itself on the compositor's frame callbacks
}

EGLAPI EGLBoolean EGLAPIENTRY eglWaitNative(EGLint engine)
{
    return EGL_TRUE;
}

EGLAPI EGLBoolean EGLAPIENTRY eglWaitGL(void)
{
    return EGL_TRUE;
}

EGLAPI __eglMustCastToProperFunctionPointerType EGLAPIENTRY eglGetProcAddress(const char *name)
{
    static const struct { const char *name; void *function; } own[] = {
        { "glGetError", (void *)glGetError },
        { "glFlush", (void *)glFlush },
        { "glFinish", (void *)glFinish },
        { "glGetString", (void *)glGetString },
        { "glGetBooleanv", (void *)glGetBooleanv },
        { "glGenBuffers", (void *)glGenBuffers },
        { "glDeleteBuffers", (void *)glDeleteBuffers },
        { "glGenTextures", (void *)glGenTextures },
        { "glDeleteTextures", (void *)glDeleteTextures },
        { "glGenFramebuffers", (void *)glGenFramebuffers },
        { "glDeleteFramebuffers", (void *)glDeleteFramebuffers },
        { "glGenRenderbuffers", (void *)glGenRenderbuffers },
        { "glDeleteRenderbuffers", (void *)glDeleteRenderbuffers },
        { "glCreateShader", (void *)glCreateShader },
        { "glCreateProgram", (void *)glCreateProgram },
        { "glDeleteShader", (void *)glDeleteShader },
        { "glDeleteProgram", (void *)glDeleteProgram },
        { "glGetUniformLocation", (void *)glGetUniformLocation },
        { "eglGetPlatformDisplay", (void *)eglGetPlatformDisplay },
        { NULL, NULL }
    };
    if (!name) {
        return NULL;
    }
    for (int i = 0; own[i].name; i++) {
        if (SDL_strcmp(own[i].name, name) == 0) {
            return (__eglMustCastToProperFunctionPointerType)own[i].function;
        }
    }
    for (int i = 0; ecmaos_gl_commands[i].name; i++) {
        if (SDL_strcmp(ecmaos_gl_commands[i].name, name) == 0) {
            return (__eglMustCastToProperFunctionPointerType)ecmaos_gl_commands[i].function;
        }
    }
    return NULL;
}

#endif // SDL_VIDEO_DRIVER_WAYLAND && SDL_VIDEO_OPENGL_EGL
