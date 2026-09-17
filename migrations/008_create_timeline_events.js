'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('timeline_events', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        comment: 'Unique identifier for the timeline event'
      },
      event_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'events', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
        comment: 'Foreign key to events.id'
      },
      claim_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'claims', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        comment: 'Foreign key to claims.id (nullable)'
      },
      article_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'articles', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        comment: 'Foreign key to articles.id (nullable)'
      },
      timeline_date: {
        type: Sequelize.DATE,
        allowNull: false,
        comment: 'Date/time of the timeline event'
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: false,
        comment: 'Description of what happened'
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      }
    });

    await queryInterface.addIndex('timeline_events', ['event_id'], {
      name: 'idx_timeline_events_event_id'
    });
    await queryInterface.addIndex('timeline_events', ['timeline_date'], {
      name: 'idx_timeline_events_timeline_date'
    });
    await queryInterface.addIndex('timeline_events', ['claim_id'], {
      name: 'idx_timeline_events_claim_id'
    });
    await queryInterface.addIndex('timeline_events', ['article_id'], {
      name: 'idx_timeline_events_article_id'
    });
    await queryInterface.addIndex('timeline_events', ['event_id', 'timeline_date'], {
      name: 'idx_timeline_events_event_date'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('timeline_events');
  }
};