/* System V IPC on WALI's musl, between this program and itself as a child: message queues (types, MSG_EXCEPT, a
 * negative type, E2BIG and MSG_NOERROR, a receive that waits for a sender, EINTR, EIDRM), semaphore sets (operations
 * made together or not at all, GETNCNT for a waiter, SEM_UNDO undone at exit, semtimedop's timeout) and shared memory
 * (one process's writes seen by the other at a semaphore, attachments counted, a removed segment kept while attached). */
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ipc.h>
#include <sys/msg.h>
#include <sys/sem.h>
#include <sys/shm.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;
static char *self;

struct message {
  long type;
  char text[32];
};

union semun {
  int val;
  struct semid_ds *buf;
  unsigned short *array;
};

static pid_t child(const char *what, int id) {
  char number[16];
  snprintf(number, sizeof number, "%d", id);
  char *argv[] = { self, (char *)what, number, 0 };
  pid_t pid;
  return posix_spawn(&pid, self, 0, 0, argv, environ) ? -1 : pid;
}

static int reap(pid_t pid) {
  int status;
  waitpid(pid, &status, 0);
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}

static void nap(void) { nanosleep(&(struct timespec){ .tv_nsec = 20000000 }, 0); }

static int send(int q, long type, const char *text) {
  struct message m = { .type = type };
  strncpy(m.text, text, sizeof m.text - 1);
  return msgsnd(q, &m, strlen(text) + 1, 0);
}

static int sem(int set, int num, int op, int flags) {
  struct sembuf b = { .sem_num = num, .sem_op = op, .sem_flg = flags };
  return semop(set, &b, 1);
}

/* --- the child's parts --- */

static int as_child(const char *what, int id) {
  struct message m;
  if (!strcmp(what, "echo")) {
    // waits for type 9, answers it as type 10 in capitals
    if (msgrcv(id, &m, sizeof m.text, 9, 0) < 0) return 1;
    for (char *c = m.text; *c; c++) if (*c >= 'a' && *c <= 'z') *c -= 32;
    m.type = 10;
    return msgsnd(id, &m, strlen(m.text) + 1, 0) ? 2 : 0;
  }
  // takes the parent's first message, which tells it the child is running, and waits for a second
  if (!strcmp(what, "removed"))
    return msgrcv(id, &m, sizeof m.text, 1, 0) < 0 ? 1 : msgrcv(id, &m, sizeof m.text, 2, 0) < 0 && errno == EIDRM ? 7 : 2;
  if (!strcmp(what, "down")) return sem(id, 0, -1, 0) ? 1 : 0;
  if (!strcmp(what, "undo")) return sem(id, 0, 3, SEM_UNDO) ? 1 : 0;
  if (!strcmp(what, "shm")) {
    // reads what the parent left, writes an answer, says so on semaphore 0 of the set the parent made with key 'w'
    int set = semget(ftok("/tmp", 'w'), 1, 0);
    char *at = shmat(id, 0, 0);
    if (at == (void *)-1 || set < 0) return 1;
    snprintf(at + 100, 64, "child read: %s", at);
    if (shmdt(at)) return 2;
    return sem(set, 0, 1, 0) ? 3 : 0;
  }
  return 99;
}

static void on_alarm(int signal) { (void)signal; }

int main(int argc, char **argv) {
  self = argv[0];
  if (argc == 3) return as_child(argv[1], atoi(argv[2]));
  struct message m;

  // message queues
  key_t key = ftok("/tmp", 'q');
  int q = msgget(key, IPC_CREAT | IPC_EXCL | 0600);
  errno = 0;
  int again = msgget(key, IPC_CREAT | IPC_EXCL | 0600);
  printf("msgget: id>=0=%d excl=%s same=%d missing=%s\n", q >= 0, again < 0 ? strerror(errno) : "-", msgget(key, 0) == q,
         msgget(ftok("/tmp", 'x'), 0) < 0 ? strerror(errno) : "-");
  send(q, 3, "three");
  send(q, 1, "one");
  send(q, 2, "two");
  struct msqid_ds ds;
  msgctl(q, IPC_STAT, &ds);
  printf("queue: qnum=%d cbytes=%d lspid=%d mode=%o\n", (int)ds.msg_qnum, (int)ds.msg_cbytes, ds.msg_lspid == getpid(), ds.msg_perm.mode & 0777);
  msgrcv(q, &m, sizeof m.text, 2, 0);
  printf("type 2: %s", m.text);
  msgrcv(q, &m, sizeof m.text, -3, 0);
  printf(", lowest to 3: %s", m.text);
  msgrcv(q, &m, sizeof m.text, 1, MSG_EXCEPT);
  printf(", not 1: %s (%ld)\n", m.text, m.type);
  send(q, 5, "a long message");
  errno = 0;
  int big = msgrcv(q, &m, 4, 0, 0) < 0 ? errno : 0;
  int cut = msgrcv(q, &m, 4, 0, MSG_NOERROR);
  errno = 0;
  int none = msgrcv(q, &m, sizeof m.text, 0, IPC_NOWAIT) < 0 ? errno : 0;
  printf("short: %s, cut=%d %.4s, empty: %s\n", strerror(big), cut, m.text, strerror(none));

  pid_t pid = child("echo", q);
  nap();
  send(q, 9, "from the parent");
  msgrcv(q, &m, sizeof m.text, 10, 0);
  printf("echo: %s exit=%d\n", m.text, reap(pid));

  struct sigaction sa = { .sa_handler = on_alarm, .sa_flags = SA_RESTART };
  sigemptyset(&sa.sa_mask);
  sigaction(SIGALRM, &sa, 0);
  ualarm(50000, 0);
  errno = 0;
  int interrupted = msgrcv(q, &m, sizeof m.text, 0, 0) < 0 ? errno : 0;
  send(q, 1, "go");
  pid = child("removed", q);
  do {
    nap();
    msgctl(q, IPC_STAT, &ds);
  } while (ds.msg_lrpid != pid);
  nap();
  msgctl(q, IPC_RMID, 0);
  printf("signal: %s, removed while waiting: exit=%d, then: %s\n", strerror(interrupted), reap(pid),
         msgsnd(q, &m, 1, 0) < 0 ? strerror(errno) : "-");

  // semaphores
  int set = semget(IPC_PRIVATE, 2, 0600);
  unsigned short values[2] = { 0, 5 };
  semctl(set, 0, SETALL, (union semun){ .array = values });
  struct sembuf both[2] = { { 1, -1, 0 }, { 0, -1, IPC_NOWAIT } };
  errno = 0;
  int together = semop(set, both, 2) < 0 ? errno : 0;
  printf("semaphores: together=%s second=%d", strerror(together), semctl(set, 1, GETVAL));
  pid = child("down", set);
  while (semctl(set, 0, GETNCNT) != 1) nap();
  printf(" waiting=%d", semctl(set, 0, GETNCNT));
  sem(set, 0, 1, 0);
  printf(" down: exit=%d value=%d pid=%d\n", reap(pid), semctl(set, 0, GETVAL), semctl(set, 0, GETPID) == pid);
  pid = child("undo", set);
  int undone = reap(pid);
  semctl(set, 0, GETALL, (union semun){ .array = values });
  struct timespec wait = { .tv_nsec = 30000000 };
  struct sembuf down = { 0, -1, 0 };
  errno = 0;
  int timed = semtimedop(set, &down, 1, &wait) < 0 ? errno : 0;
  struct semid_ds sds;
  semctl(set, 0, IPC_STAT, (union semun){ .buf = &sds });
  printf("undo: exit=%d values=%d,%d timed out=%s nsems=%d\n", undone, values[0], values[1], strerror(timed), (int)sds.sem_nsems);
  semctl(set, 0, IPC_RMID);

  // shared memory
  key_t shmkey = ftok("/tmp", 'h');
  int shm = shmget(shmkey, 10000, IPC_CREAT | 0600);
  int ready = semget(ftok("/tmp", 'w'), 1, IPC_CREAT | 0600);
  char *at = shmat(shm, 0, 0);
  strcpy(at, "hello from the parent");
  pid = child("shm", shm);
  sem(ready, 0, -1, 0);
  // what the child wrote is here once the semaphore is: copied before any other call could bring it in
  char seen[64];
  memcpy(seen, at + 100, sizeof seen);
  struct shmid_ds mds;
  shmctl(shm, IPC_STAT, &mds);
  printf("shm: %s, exit=%d segsz=%d nattch=%d cpid=%d\n", seen, reap(pid), (int)mds.shm_segsz, (int)mds.shm_nattch, mds.shm_cpid == getpid());
  char *again_at = shmat(shm, 0, SHM_RDONLY);
  shmctl(shm, IPC_STAT, &mds);
  int two = mds.shm_nattch;
  shmdt(again_at);
  shmctl(shm, IPC_RMID, 0);
  int fresh = shmget(shmkey, 100, IPC_CREAT | 0600);
  strcpy(at, "still mapped");
  shmctl(shm, IPC_STAT, &mds);
  printf("removed: attached=%d %s, dest=%d, new id=%d", two, at, !!(mds.shm_perm.mode & SHM_DEST), fresh != shm);
  shmdt(at);
  errno = 0;
  printf(", after detach: %s, shmdt again: %s\n", shmctl(shm, IPC_STAT, &mds) < 0 ? strerror(errno) : "-",
         shmdt(at) < 0 ? strerror(errno) : "-");
  shmctl(fresh, IPC_RMID, 0);
  semctl(ready, 0, IPC_RMID);
  return 0;
}
