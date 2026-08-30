"""Franchises a league doesn't have any more.

A release rates every team its model has ever seen, because that is what
training on a decade of seasons produces. For the college leagues that's
right -- the teams are all still out there. For a closed pro league it isn't:
the wnba leaderboard carried the Houston Comets, who folded in 2008, ranked
among teams playing tonight, and the matchup picker offered them as an
opponent. That isn't a rating anyone can use.

**Folded, not moved.** The only teams here are the ones that stopped existing.
A relocated franchise is the *same team* under a later name -- the Detroit
Shock became the Tulsa Shock and then the Dallas Wings, and the Wings' rating
is the continuation of the Shock's -- so hiding the old name would drop a live
team's history off the board while its current name sits above it with a
rating that starts at the relocation. The fix for those is a rename where the
names are known (`call_it_what_you_want`, whose whole job is that every name a
team has gone by resolves to the one to use now), and until that lands they
belong on the board under whatever ESPN called them. A hide here would only
paper over the split, and worse: it would make the split invisible.

**A list of names, not a rule.** Nothing in a `ModelRelease` says when a team
last played: the ratings are a mapping of name to number, and the win/loss
record beside each is this season's, which is 0-0 for every team in the league
in April. The signal that would answer it properly is the schedule -- a team
with no games in the current season file doesn't play any more -- and reaching
for it would make `/api/leagues/{league}/ratings` a reader of endgame's bucket,
which is a second upstream, a second failure mode, and a second cache in front
of an endpoint that currently has none of them. Five names for a league of a
dozen-odd teams is the cheaper answer by a wide margin.

**A list of the gone, not a roster of the current.** The other direction reads
better and fails worse: an expansion team, or a franchise ESPN renames, would
be missing from a roster and silently dropped off the leaderboard the season it
starts playing. Listed this way, the new team shows up on its own and only a
team that *folds* needs an edit here.

**Names, and franchises are not names.** The entries below are names, matched
as names, which is what the Portland Fire needs: they folded in 2002 and the
name came back as a 2026 expansion team, so the list carries neither, and a
rule that hid every dead franchise's name would have hidden a team playing
this week.

Only the leaderboard and the matchup picker read this (`app.api.ratings`).
`/api/predict` still answers for a team that's here, and deliberately: a saved
link to an old matchup is a fair question about what the ratings say, and the
prediction was never a claim that the game is on the schedule.
"""

# The wnba franchises that folded, with the seasons they played. Sourced from
# the franchise histories rather than from any file we hold, which is the
# maintenance cost this module buys its cheapness with: a team that folds needs
# a line here.
#
# Nothing that merely moved or was renamed belongs on this list -- see the
# docstring. Two entries someone would add by mistake: the Portland Fire, whose
# name a 2026 expansion team took back, and any of the relocations (Detroit ->
# Tulsa -> Dallas, Utah -> San Antonio -> Las Vegas, Orlando -> Connecticut),
# which are one continuing team apiece and a renaming job upstream.
_WNBA_FOLDED = {
    "Charlotte Sting": "1997-2006",
    "Cleveland Rockers": "1997-2003",
    "Houston Comets": "1997-2008",
    "Miami Sol": "2000-2002",
    "Sacramento Monarchs": "1997-2009",
}

_FOLDED: dict[str, frozenset[str]] = {
    "wnba": frozenset(name.casefold() for name in _WNBA_FOLDED),
}


def still_playing(league: str, team: str) -> bool:
    """Whether `league` still has the franchise that played under this name.

    True for a team that moved or was renamed: the franchise plays on, and the
    old name is a naming problem rather than a dead team.

    Case- and space-insensitive, because the names are matched against
    whatever ESPN wrote into a season file years ago and this is not the place
    to be exact about capitalisation. Every league without an entry says yes to
    everything, which is the right answer for the college leagues and the right
    default for a league nobody has curated.
    """
    return team.strip().casefold() not in _FOLDED.get(league.casefold(), frozenset())
