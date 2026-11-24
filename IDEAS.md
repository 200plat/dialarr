# Ideas

Things Dialarr could grow into, written down so they don't get lost. None of this
is built — it is the shape of the next few ideas, and the reason each one is worth
doing (or worth waiting on).

The rule behind all of it: **the channels should look after themselves.** Right now
you build a channel and it stays as you left it. The idea below is a channel that
notices when the world changes and puts the right thing on air without being asked.

---

## New This Week

A channel nobody has to maintain. You tell it which folders to watch, and every
week it works out what is new.

- **Watch folders, not files.** Point it at a folder per show. Something else on
  the machine (Sonarr, Radarr, a manual download) drops new episodes in; Dialarr
  notices and adds them.
- **A week is a week.** Anything older than seven days is dropped off the front of
  the channel, so the channel is always the last seven days of something. It is a
  rolling window, not a shelf.
- **Off by default.** It is a channel you turn on, like any other. Nobody's
  existing lineup changes because of it.

**Why it is not built yet:** watching a folder for changes is a background job with
its own failure modes — a file that is half-written looks like a new episode, a
folder that is briefly missing looks like every episode was deleted. It wants a
real "has this file changed" watcher rather than a polling loop, and a way to say
"this one is still downloading" instead of guessing from its size.

## A library, Sonarr/Radarr style

The bigger version of the same idea: Dialarr reads the library rather than being
told about it.

- **Scan the TV and Movie directories** and work out what is there — what is a
  show, what is an episode, which season and episode number each one is.
- **Know the metadata.** Pull the show name, the category and the description from
  TheTVDB (or TMDb for films) the way Sonarr does, so the library can be browsed
  by genre, decade and network instead of by folder.
- **Add a show, not an episode.** Today a channel is a list of files you picked.
  With a library, you add *The Simpsons* to a channel and it plays season 1, and
  when season 2 lands next year the channel plays that too, with no work from you.
- **Everything becomes searchable.** "Which episodes of Star Trek are on this
  box?" becomes a question with an answer.

**Why it is not built yet:** this is the one that turns Dialarr into something
else. A library is a database with a scanner, a metadata client, a matcher and a
dedupe rule — and every one of those is a place to be wrong. It also means
Dialarr stops being a small thing you run on a box and starts being a thing you
maintain.

## Commercials written for the show

The generated commercials are random quips with the channel's name in them. That
could be a lot better, and it could update itself.

- **Ten to fifteen commercials per show**, written for that show — the jokes come
  from the show itself, not from the channel.
- **A new one every few episodes**, so a long-running channel does not repeat
  itself all week.
- **A special one for the moment**: a season finale, a new season starting, a
  milestone episode. Something that only exists because of what just happened in
  the show.
- **They update as the show does.** New episode, new commercials. The channel
  refreshes itself, the same way the library would.

**Why it is not built yet:** the commercials are generated from a template, and
writing ones that are actually about a show means either a lot of hand-written
text per show, or a model in the loop — which brings its own questions about cost,
offline use and what it invents.

## The cost of all of this

Worth saying plainly, because the current Dialarr is deliberately small: it is one
Node process, a JSON file and a folder of cached mp4s, and it does not care what
is on your disk until you tell it.

Every idea above turns that around:

- channels that update themselves mean the server rebuilds manifests and shifts
  versions underneath viewers, and a bug there shows up as the wrong thing on
  screen for everybody at once;
- watching folders means background jobs, file-watching, and the half-written-file
  problem;
- a library means a database, a scanner and a metadata client — new dependencies,
  new failure modes, and a lot more to go wrong at 3am;
- automatic commercials mean either hand-written content per show, or a model call
  per update.

None of that is a reason not to do it. It is a reason to do one piece at a time,
to keep the old way working alongside the new one, and to keep the box cheap
enough to run on whatever is lying around.

---

*Have an idea of your own? Open an issue.*
