package com.cornerdeli.cartablet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NavigatorTest {
    // East 500 m along First St, then north 300 m on Second St.
    private fun route() = Navigator(
        doubleArrayOf(0.0, 250.0, 500.0, 500.0), doubleArrayOf(0.0, 0.0, 0.0, 300.0),
        listOf(
            Step(0.0, 0.0, "depart", "Head east on First Street", "First Street"),
            Step(500.0, 0.0, "left", "Turn left onto Second Street", "Second Street"),
            Step(500.0, 300.0, "arrive", "You have arrived", "Second Street"),
        ),
    )

    @Test fun announcesTheTurnEarlyThenAtTheCorner() {
        val nav = route()
        assertNull(nav.announcement(nav.update(50.0, 2.0)))          // 450 m out: nothing yet
        assertEquals("In 800 feet, turn left onto Second Street", nav.announcement(nav.update(255.0, 3.0)))
        assertNull(nav.announcement(nav.update(270.0, 3.0)))          // said once
        assertEquals("Turn left onto Second Street", nav.announcement(nav.update(470.0, 1.0)))
    }

    @Test fun knowsWhenTheCarLeftTheRoute() {
        val nav = route()
        repeat(2) { nav.update(250.0, 80.0) }
        assertFalse(nav.offRoute)
        nav.update(250.0, 80.0)
        assertTrue(nav.offRoute)
        nav.update(260.0, 2.0)
        assertFalse(nav.offRoute)
    }

    @Test fun arrivesNearTheEnd() {
        val nav = route()
        nav.update(500.0, 100.0)
        val progress = nav.update(500.0, 285.0)
        assertTrue(nav.arrived(progress))
        assertEquals(2, progress.nextStep)
    }

    @Test fun distancesInFeetThenMiles() {
        assertEquals("300 feet", Navigator.distanceText(91.0))
        assertEquals("0.2 miles", Navigator.distanceText(300.0))
        assertEquals("1 mile", Navigator.distanceText(1609.0))
    }

    @Test fun testDriveFollowsTheRoute() {
        val nav = route()
        val (x, y, heading) = nav.positionAt(600.0)
        assertEquals(500.0, x, 0.01); assertEquals(100.0, y, 0.01); assertEquals(0f, heading, 0.5f)
        assertEquals(90f, nav.positionAt(100.0).third, 0.5f)
    }
}
