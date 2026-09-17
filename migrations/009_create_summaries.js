'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('summaries', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        comment: 'Unique identifier for the summary'
      },
      event_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'events', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
        comment: 'Foreign key to events.id'
      },
      summary_text: {
        type: Sequelize.TEXT('long'),
        allowNull: false,
        comment: 'Generated AI summary'
      },
      model_provider: {
        type: Sequelize.ENUM('gemini', 'openai', 'local'),
        allowNull: false,
        defaultValue: 'gemini',
        comment: 'AI model provider used'
      },
      model_version: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: 'Version of the model used'
      },
      generated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
        comment: 'When the summary was generated'
      },
      verification_status: {
        type: Sequelize.ENUM('pending', 'verified', 'needs_review'),
        allowNull: false,
        defaultValue: 'pending',
        comment: 'Verification status'
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

    await queryInterface.addIndex('summaries', ['event_id'], {
      name: 'idx_summaries_event_id'
    });
    await queryInterface.addIndex('summaries', ['generated_at'], {
      name: 'idx_summaries_generated_at'
    });
    await queryInterface.addIndex('summaries', ['model_provider'], {
      name: 'idx_summaries_model_provider'
    });
    await queryInterface.addIndex('summaries', ['verification_status'], {
      name: 'idx_summaries_verification_status'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('summaries');
  }
};