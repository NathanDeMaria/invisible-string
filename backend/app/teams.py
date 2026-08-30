"""Teams a league doesn't field any more.

A release rates every team its model has ever seen, because that is what
training on a decade of seasons produces. For the college leagues that's
right -- the teams are all still out there. For a closed pro league it isn't:
the wnba leaderboard carried the Houston Comets, who folded in 2008, ranked
among teams playing tonight, and the matchup picker offered them as an
opponent. Neither is a rating anyone can use.

**A list of names, not a rule.** Nothing in a `ModelRelease` says when a team
last played: the ratings are a mapping of name to number, and the win/loss
record beside each is this season's, which is 0-0 for every team in the league
in April. The signal that would answer it properly is the schedule -- a team
with no games in the current season file doesn't play any more -- and reaching
for it would make `/api/leagues/{league}/ratings` a reader of endgame's bucket,
which is a second upstream, a second failure mode, and a second cache in front
of an endpoint that currently has none of them. Eleven names for a league of
a dozen-odd teams is the cheaper answer by a wide margin.

**A list of the gone, not a roster of the current.** The other direction reads
better and fails worse: an expansion team, or a franchise ESPN renames, would
be missing from a roster and silently dropped off the leaderboard the season it
starts playing. Listed this way, the new team shows up on its own and only a
team that *stops* needs an edit here.

**Names, and franchises are not names.** The entries below are the names no
team answers to now, which is not the same as the franchises that folded: a
relocated team keeps playing under its new name, and its old one belongs here.
The reverse case is why this is worth saying out loud -- the Portland Fire
folded in 2002 and the name came back as a 2026 expansion team, so it is
deliberately *not* on this list, and a rule that hid every dead franchise's
name would have hidden a team playing this week.

Only the leaderboard and the matchup picker read this (`app.api.ratings`).
`/api/predict` still answers for a team that's here, and deliberately: a saved
link to an old matchup is a fair question about what the ratings say, and the
prediction was never a claim that the game is on the schedule.
"""

# The wnba names no team answers to now, with the last season each was used
# and what became of it. Sourced from the franchise histories rather than from
# any file we hold, which is the maintenance cost this module buys its
# cheapness with: a team that stops playing needs a line here.
#
# Not on the list, on purpose: the Portland Fire, who folded in 2002 and whose
# name came back as a 2026 expansion team. It is the whole reason the docstring
# insists these are names rather than franchises, and the one entry someone
# reading a list of dead franchises would add by mistake.
_WNBA_RETIRED = {
    "Charlotte Sting": "1997-2006, folded",
    "Cleveland Rockers": "1997-2003, folded",
    "Houston Comets": "1997-2008, folded",
    "Miami Sol": "2000-2002, folded",
    "Sacramento Monarchs": "1997-2009, folded",
    "Detroit Shock": "1998-2009, moved and became the Tulsa Shock",
    "Tulsa Shock": "2010-2015, moved and became the Dallas Wings",
    "Orlando Miracle": "1999-2002, moved and became the Connecticut Sun",
    "Utah Starzz": "1997-2002, moved and became the San Antonio Silver Stars",
    "San Antonio Silver Stars": "2003-2013, renamed the San Antonio Stars",
    "San Antonio Stars": "2014-2017, moved and became the Las Vegas Aces",
}

_RETIRED: dict[str, frozenset[str]] = {
    "wnba": frozenset(name.casefold() for name in _WNBA_RETIRED),
}


def still_playing(league: str, team: str) -> bool:
    """Whether `team` is a name some team in `league` still answers to.

    Case- and space-insensitive, because the names are matched against
    whatever ESPN wrote into a season file years ago and this is not the place
    to be exact about capitalisation. Every league without an entry says yes to
    everything, which is the right answer for the college leagues and the right
    default for a league nobody has curated.
    """
    return team.strip().casefold() not in _RETIRED.get(league.casefold(), frozenset())
